import { prisma } from "../lib/prisma";
import { nanoid } from "nanoid";
import socketService from "./socket.service";
import * as webhookService from "./webhook.service";
import * as workflowExecutor from "./workflowExecutor.service";
import * as presenceService from "./presence.service";
import logger from '../lib/logger';
import { StartConversationInput, SendMessageInput } from '../routes/chat.routes';
import { generateChatCompletion } from '../lib/openai';
import { truncateMessages, getModelTokenLimit } from '../lib/tokenCounter';
import { defaultDutchDirectives } from '../lib/prompts';

export class ChatError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = "ChatError";
  }
}


export async function startConversation(input: StartConversationInput) {
  const widget = await prisma.widget.findFirst({
    where: {
      id: input.widgetId,
      isActive: true,
      deletedAt: null,
    },
    include: {
      agent: true,
    },
  });

  if (!widget) {
    throw new ChatError("Widget not found or inactive", 404);
  }

  // Generate visitor ID if not provided
  const visitorId = input.visitorId || `visitor_${nanoid(12)}`;

  const conversation = await prisma.conversation.create({
    data: {
      workspaceId: widget.workspaceId,
      widgetId: widget.id,
      agentId: widget.agentId,
      visitorId,
      visitorName: input.visitorName,
      visitorEmail: input.visitorEmail,
      visitorMetadata: input.visitorMetadata,
      source: "web",
    },
    include: {
      agent: {
        include: {
          workflow: true,
        },
      },
      widget: true,
    },
  });

  // Send greeting message if configured
  if (widget.greeting) {
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "ASSISTANT",
        content: widget.greeting,
      },
    });
  }

  // Initialize workflow if agent has one
  if (conversation.agent?.workflowId) {
    try {
      logger.info('Initializing workflow for conversation', {
        conversationId: conversation.id,
        workflowId: conversation.agent.workflowId,
      });

      await workflowExecutor.initializeWorkflowForConversation(
        conversation.id,
        conversation.agent.workflowId,
        {
          visitorName: conversation.visitorName,
          visitorEmail: conversation.visitorEmail,
          source: conversation.source,
        }
      );

      logger.info('Workflow initialized successfully', {
        conversationId: conversation.id,
        workflowId: conversation.agent.workflowId,
      });
    } catch (error: any) {
      logger.error('Failed to initialize workflow', {
        error: error?.message,
        stack: error?.stack,
        conversationId: conversation.id,
        workflowId: conversation.agent.workflowId,
      });
      // Continue without workflow - but log it prominently
    }
  } else {
    logger.info('No workflow assigned to agent', {
      conversationId: conversation.id,
      agentId: conversation.agentId,
    });
  }

  // Send webhook for new conversation
  await webhookService.sendWebhook(
    widget.workspaceId,
    webhookService.WEBHOOK_EVENTS.CONVERSATION_CREATED,
    {
      conversationId: conversation.id,
      visitorName: conversation.visitorName,
      visitorEmail: conversation.visitorEmail,
      source: conversation.source,
    }
  );

  return conversation;
}

export async function getConversation(conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: conversationId,
    },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
      },
      agent: true,
      widget: true,
    },
  });

  if (!conversation) {
    throw new ChatError("Conversation not found", 404);
  }

  return conversation;
}

export async function getConversationMessages(
  conversationId: string,
  page: number = 1,
  pageSize: number = 50
) {
  const skip = (page - 1) * pageSize;

  const [messages, total] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
      skip,
      take: pageSize,
    }),
    prisma.message.count({
      where: { conversationId },
    }),
  ]);

  return {
    messages,
    pagination: {
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      hasMore: skip + messages.length < total,
    },
  };
}


export async function sendMessage(input: SendMessageInput) {
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: input.conversationId,
    },
    include: {
      agent: {
        include: {
          knowledgeBase: true,
          workflow: true,
        },
      },
      messages: {
        orderBy: { createdAt: "desc" },
        take: 30, // Last 30 messages for context
      },
      assignedTo: true,
    },
  });

  if (!conversation) {
    throw new ChatError("Conversation not found", 404);
  }

  // Reverse messages to get them in chronological order
  conversation.messages = conversation.messages.reverse();

  // If message is from an AGENT (human agent via dashboard), check if they are assigned
  if (input.role === "AGENT") {
    if (!conversation.assignedToId) {
      throw new ChatError("You must be assigned to this conversation before sending messages", 403);
    }

    // Check if the sender is the assigned agent
    if (input.senderId && conversation.assignedToId !== input.senderId) {
      throw new ChatError("Only the assigned agent can send messages to this conversation", 403);
    }
  }

  // Save user message
  const userMessage = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: input.role || "USER",
      content: input.content,
      senderId: input.senderId,
      metadata: input.currentPageUrl ? { currentPageUrl: input.currentPageUrl } : null,
    },
  });

  // Debug: Log URL storage
  if (input.currentPageUrl) {
    logger.info('🌐 Stored currentPageUrl', { currentPageUrl: input.currentPageUrl, conversationId: conversation.id });
  }

  // Broadcast message via Socket.io
  socketService.broadcastMessage(conversation.id, userMessage);

  // Update conversation lastMessageAt
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });

  // Send webhook for new message from user
  if (input.role !== "AGENT") {
    await webhookService.sendWebhook(
      conversation.workspaceId,
      webhookService.WEBHOOK_EVENTS.MESSAGE_RECEIVED,
      {
        conversationId: conversation.id,
        messageId: userMessage.id,
        message: userMessage.content,
        visitorName: conversation.visitorName,
      }
    );
  }

  // If message is from an AGENT (dashboard user), don't generate AI response
  if (input.role === "AGENT") {
    return { userMessage, aiMessage: null };
  }

  // Check if user is requesting a human agent
  const isRequestingHuman = detectHumanAgentRequest(input.content);

  if (isRequestingHuman) {
    logger.info('User requesting human agent', { conversationId: conversation.id });

    // Check availability
    const availability = await checkAgentAvailability(
      conversation.workspaceId,
      conversation.widgetId
    );

    if (!availability.available) {
      // No agents available - send configured message
      const offlineMessage = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "ASSISTANT",
          content: availability.message,
          metadata: { source: "agent_unavailable", reason: availability.reason },
        },
      });

      socketService.broadcastMessage(conversation.id, offlineMessage);
      return { userMessage, aiMessage: offlineMessage };
    } else {
      // Agents are available - mark conversation as WAITING and notify agents
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          status: "WAITING",
          visibleInDashboard: true // Make visible when human agent is requested
        },
      });

      // Notify all online agents in the workspace via Socket.io
      socketService.notifyHumanAgentRequested(conversation.workspaceId, {
        conversationId: conversation.id,
        visitorName: conversation.visitorName || "Anonymous",
        lastMessage: input.content,
      });

      // Send message to user
      const notificationMessage = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "ASSISTANT",
          content: "Een moment, ik verbind je door met een beschikbare medewerker...",
          metadata: { source: "agent_connecting" },
        },
      });

      socketService.broadcastMessage(conversation.id, notificationMessage);

      // Send webhook
      await webhookService.sendWebhook(
        conversation.workspaceId,
        webhookService.WEBHOOK_EVENTS.HUMAN_HANDOFF_REQUESTED,
        {
          conversationId: conversation.id,
          visitorName: conversation.visitorName,
          lastMessage: input.content,
        }
      );

      return { userMessage, aiMessage: notificationMessage };
    }
  }

  // If human agent has taken over, don't generate AI response for customer messages
  if (conversation.assignedToId) {
    return { userMessage, aiMessage: null };
  }

  // Check if workflow is handling this message (only for USER messages)
  const isUserMessage = !input.role || input.role === "USER";
  if (isUserMessage && conversation.agent?.workflowId) {
    logger.info('Checking workflow for message', {
      conversationId: conversation.id,
      workflowId: conversation.agent.workflowId,
    });

    let workflowResult = await workflowExecutor.handleMessageInWorkflow(
      conversation.id,
      input.content,
      { currentPageUrl: input.currentPageUrl }
    );

    // If workflow returned null but workflow should be running, try to reinitialize
    if (workflowResult === null) {
      logger.warn('Workflow returned null - attempting recovery', {
        conversationId: conversation.id,
        workflowId: conversation.agent.workflowId,
      });

      try {
        await workflowExecutor.initializeWorkflowForConversation(
          conversation.id,
          conversation.agent.workflowId,
          {
            visitorName: conversation.visitorName,
            visitorEmail: conversation.visitorEmail,
            source: conversation.source,
            recoveryMode: true,
          }
        );

        logger.info('Workflow recovery successful, retrying message', {
          conversationId: conversation.id,
        });

        // Try again with newly initialized workflow
        workflowResult = await workflowExecutor.handleMessageInWorkflow(
          conversation.id,
          input.content,
          { currentPageUrl: input.currentPageUrl }
        );
      } catch (error: any) {
        logger.error('Workflow recovery failed', {
          conversationId: conversation.id,
          error: error?.message,
        });
      }
    }

    if (workflowResult?.shouldRespond) {
      // Workflow wants to send a response (e.g., validation error)
      const errorMessage = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "AGENT",
          content: workflowResult.response || "Error processing your request",
          metadata: { source: "workflow_validation" },
        },
      });

      socketService.broadcastMessage(conversation.id, errorMessage);
      return { userMessage, aiMessage: errorMessage };
    }

    if (workflowResult?.continueWorkflow) {
      // Workflow is handling the message, don't generate AI response
      logger.info('Workflow is handling message', { conversationId: conversation.id });
      return { userMessage, aiMessage: null };
    }
  }

  // Check if agent blocks competitor questions
  if (conversation.agent?.blockCompetitorQuestions && detectCompetitorQuestion(input.content)) {
    const competitorBlockMessage = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "ASSISTANT",
        content: "Sorry, ik kan geen informatie geven over andere bedrijven of concurrenten. Ik kan je wel helpen met vragen over onze eigen producten en diensten!",
        metadata: { source: "competitor_block" },
      },
    });

    socketService.broadcastMessage(conversation.id, competitorBlockMessage);
    return { userMessage, aiMessage: competitorBlockMessage };
  }

  // Broadcast AI thinking indicator
  socketService.broadcastAIResponseStarted(conversation.id);

  // Generate AI response with page context
  const aiMessage = await generateAIResponse(conversation, input.content, input.currentPageUrl);

  // Broadcast AI response
  if (aiMessage) {
    socketService.broadcastAIResponseCompleted(conversation.id, aiMessage);
  }

  return { userMessage, aiMessage };
}

async function generateAIResponse(conversation: any, userMessage: string, currentPageUrl?: string) {
  const agent = conversation.agent;
  const startTime = Date.now();

  try {
    // Get page-specific context if user is on a specific page
    let pageContext = "";
    let pageSources: any[] = [];

    if (currentPageUrl && agent.knowledgeBaseId) {
      const { getPageContext } = await import("./scraper.service");
      try {
        const context = await getPageContext(currentPageUrl, agent.knowledgeBaseId);
        if (context) {
          pageContext = `\n\n<page_context>\nCurrent page url: ${currentPageUrl}\n\n${context.content}\n</page_context>\n`;
          pageSources = context.sources;
        } else {
          // Fallback to KB search if no page context is available for this URL
          try {
            const urlParts = new URL(currentPageUrl).pathname.split('/').filter(Boolean);
            if (urlParts.length > 0) {
              const fallbackQuery = urlParts.join(' ');
              const { searchKnowledgeBase } = await import("./knowledgeBase.service");
              const fallbackResults = await searchKnowledgeBase(agent.knowledgeBaseId, fallbackQuery, 3);
              if (fallbackResults.length > 0) {
                const fallbackContent = fallbackResults.map(r => r.content).join("\n\n");
                pageContext = `\n\n<page_context>\n${fallbackContent}\n</page_context>\n`;
                pageSources = fallbackResults.map((r, i) => ({
                  id: i + 1,
                  content: r.content.substring(0, 200),
                  documentTitle: r.documentTitle,
                  sourceUrl: r.sourceUrl,
                  score: r.score,
                }));
              }
            }
          } catch (urlSearchError) {
            // Log but don't fail if the fallback fails
            logger.warn("URL fallback search failed", { error: urlSearchError });
          }
        }
      } catch (error: any) {
        logger.error("Page context error", { error: error.message });
      }
    }

    // Search knowledge base if agent has one
    let kbContext = "";
    let kbSources: any[] = [];

    // --- Query Reformulation for Context-Aware RAG ---
    let searchTargetQuery = userMessage;

    // Only reformulate if we have previous conversation history to contextualize
    if (conversation.messages && conversation.messages.length > 0) {
      // Build a minimal history array for the LLM
      const recentHistory = conversation.messages.slice(-5).map((m: any) => `${m.role === 'USER' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');

      const reformulationPrompt = `Given the following conversation history and the latest user query, rewrite the user query into a standalone, comprehensive question that captures all context needed for a knowledge base search. If the latest query is already standalone, return it exactly as is (no preamble, no quotes).\n\nHistory:\n${recentHistory}\n\nLatest Query: ${userMessage}\n\nStandalone Query:`;

      try {
        const reformulateResult = await generateChatCompletion(
          [
            { role: "system", content: "You are an expert search engineer. Rewrite user queries into standalone search terms based on context." },
            { role: "user", content: reformulationPrompt }
          ],
          "gpt-4o-mini",
          { max_tokens: 100, temperature: 0 }
        );

        const generatedQuery = reformulateResult.choices?.[0]?.message?.content?.trim();
        if (generatedQuery && generatedQuery !== "") {
          searchTargetQuery = generatedQuery;
          logger.info("Query reformulated for RAG", { original: userMessage, reformulated: searchTargetQuery, conversationId: conversation.id });
        }
      } catch (refError) {
        logger.warn("Query reformulation failed, falling back to original verbatim", { error: refError });
      }
    }


    if (agent.knowledgeBaseId) {
      const { searchKnowledgeBase } = await import("./knowledgeBase.service");
      try {
        // INCREASED LIMIT for "Super System" - extensive context retrieval
        const results = await searchKnowledgeBase(agent.knowledgeBaseId, searchTargetQuery, 10);
        if (results.length > 0) {
          kbContext = "\n\n<knowledge_base_context>\n" +
            results.map((r, i) => `[Source ${i + 1}] (Title: ${r.documentTitle}): ${r.content}`).join("\n\n") +
            "\n</knowledge_base_context>\n";

          // Extract sources with URLs
          kbSources = results.map((r, i) => ({
            id: i + 1,
            content: r.content.substring(0, 200),
            documentTitle: r.documentTitle,
            sourceUrl: r.sourceUrl,
            score: r.score,
          }));
        }
      } catch (error: any) {
        logger.error("KB search error", { error: error.message });
      }
    }

    // Use default Dutch directives if none exist on the agent (or just append)
    const directivesToUse = defaultDutchDirectives;
    const systemPrompt = agent.systemPrompt + pageContext + kbContext + directivesToUse;

    let messages: any[] = [
      {
        role: "system",
        content: systemPrompt,
      },
    ];

    // Check for conversation summary in state
    const summary = (conversation.state as any)?.summary as string | undefined;
    const lastSummarizedMessageId = (conversation.state as any)?.lastSummarizedMessageId as string | undefined;
    let messagesToInclude = conversation.messages;

    if (summary) {
      messages.push({
        role: "system",
        content: `PREVIOUS CONVERSATION SUMMARY: \n${summary}\n\nUse this context for the following messages.`
      });

      // If we have a lastSummarizedMessageId, only include messages after it
      if (lastSummarizedMessageId) {
        const summarizeIndex = conversation.messages.findIndex((m: any) => m.id === lastSummarizedMessageId);
        if (summarizeIndex >= 0) {
          messagesToInclude = conversation.messages.slice(summarizeIndex + 1);
        }
      }
    }

    // Add conversation history
    messagesToInclude.forEach((msg: any) => {
      if (msg.role === "USER") {
        messages.push({ role: "user", content: msg.content });
      } else if (msg.role === "ASSISTANT") {
        messages.push({ role: "assistant", content: msg.content });
      }
    });

    // Add current message
    messages.push({ role: "user", content: userMessage });

    // Truncate messages if they exceed token limit
    const modelLimit = getModelTokenLimit(agent.aiModel);
    const reserveForResponse = agent.maxTokens || 1000;
    messages = truncateMessages(messages, {
      maxTokens: modelLimit - reserveForResponse,
      systemMessage: messages[0],
      preserveRecent: 10,
    });

    // Call OpenAI with streaming enabled
    const stream = await generateChatCompletion(
      messages,
      agent.aiModel,
      {
        temperature: agent.temperature,
        max_tokens: agent.maxTokens,
        stream: true,
      }
    ) as any; // Cast as any because stream returns AsyncIterable for chunks

    let fullResponse = "";
    const messageId = nanoid(); // Generate a temporary ID for the streaming message

    // Broadcast initial message start
    socketService.getIO()?.to(`conversation:${conversation.id}`).emit('ai:stream:start', {
      id: messageId,
      conversationId: conversation.id,
      role: 'ASSISTANT',
      timestamp: new Date()
    });

    try {
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || "";
        if (content) {
          fullResponse += content;
          // Emit chunk to client
          socketService.getIO()?.to(`conversation:${conversation.id}`).emit('ai:stream:chunk', {
            id: messageId,
            conversationId: conversation.id,
            content: content
          });
        }
      }
    } catch (streamError) {
      logger.error("Streaming error", { error: streamError });
      // If we got nothing, fallback
      if (!fullResponse) {
        throw streamError;
      }
    }

    // Notify streaming complete
    socketService.getIO()?.to(`conversation:${conversation.id}`).emit('ai:stream:end', {
      id: messageId,
      conversationId: conversation.id,
    });

    const isFallback = !fullResponse;
    const aiResponse = fullResponse || agent.fallbackMessage || "I'm sorry, I couldn't generate a response.";

    // Estimate tokens
    const promptTokens = Math.floor(systemPrompt.length / 4) + messages.reduce((acc, m) => acc + (m.content?.length || 0) / 4, 0);
    const completionTokens = Math.floor(aiResponse.length / 4);
    const tokens = promptTokens + completionTokens;
    const latency = Date.now() - startTime;

    // Background task: Summarize conversation if it's getting long
    if (conversation.messages && conversation.messages.length >= 20) {
      // Run in background so it doesn't block the response
      summarizeConversation(conversation.id).catch(err => {
        logger.error("Failed to summarize conversation", { error: err.message });
      });
    }

    // Save AI message with sources
    const aiMessage = await prisma.message.create({
      data: {
        id: messageId, // Use the same ID we streamed with so frontend can replace it
        conversationId: conversation.id,
        role: "ASSISTANT",
        content: aiResponse,
        metadata: {
          model: agent.aiModel,
          sources: [...pageSources, ...kbSources],
          currentPageUrl,
          source: isFallback ? "fallback" : "ai_generated",
        },
        tokens,
        latency,
      },
    });

    return aiMessage;
  } catch (error: any) {
    logger.error("AI response error", { error: error.message });

    // Save fallback message
    return prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "ASSISTANT",
        content: agent.fallbackMessage || "I'm experiencing technical difficulties. Please try again.",
        metadata: {
          error: error.message,
          source: "fallback",
        },
        latency: Date.now() - startTime,
      },
    });
  }
}

/**
 * Summarizes the conversation to compress history and save tokens
 * Runs asynchronously in the background
 */
async function summarizeConversation(conversationId: string) {
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        agent: true,
        messages: {
          orderBy: { createdAt: "asc" },
        },
      }
    });

    if (!conversation || !conversation.agent || conversation.messages.length < 20) return;

    // We only summarize up to the last 10 messages (leave recent context intact)
    const messagesToSummarize = conversation.messages.slice(0, conversation.messages.length - 10);
    if (messagesToSummarize.length < 5) return; // Not enough to summarize

    const previousSummary = ((conversation.state as any)?.summary as string) || "";

    // Format the history to summarize
    const formattedHistory = messagesToSummarize
      .map(m => `${m.role === 'USER' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');

    let summaryPrompt = `Please summarize the following conversation history concisely, keeping all important facts, customer details, constraints, and the core intent of the user. Focus on information that will be relevant for answering future questions. Output ONLY the summary.\n\n`;

    if (previousSummary) {
      summaryPrompt += `PREVIOUS SUMMARY:\n${previousSummary}\n\n`;
      summaryPrompt += `NEW MESSAGES TO ADD TO SUMMARY:\n${formattedHistory}`;
    } else {
      summaryPrompt += `CONVERSATION TO SUMMARIZE:\n${formattedHistory}`;
    }

    const response = await generateChatCompletion([
      { role: "system", content: "You are an AI assistant specialized in heavily summarizing conversation histories into dense, factual context blobs." },
      { role: "user", content: summaryPrompt }
    ], "gpt-4o-mini", { temperature: 0.1, max_tokens: 500 });

    const newSummary = response.choices?.[0]?.message?.content?.trim();
    if (!newSummary) return;

    // Update the conversation state with the new summary
    const currentState = (conversation.state as any) || {};
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        state: {
          ...currentState,
          summary: newSummary,
          lastSummarizedMessageId: messagesToSummarize[messagesToSummarize.length - 1].id
        }
      }
    });

    logger.info("Conversation summarized successfully", {
      conversationId: conversation.id,
      messagesSummarized: messagesToSummarize.length
    });
  } catch (error: any) {
    logger.error("Failed to summarize conversation", { error: error.message, conversationId });
  }
}

export async function assignConversationToHuman(
  conversationId: string,
  userId: string
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId },
  });

  if (!conversation) {
    throw new ChatError("Conversation not found", 404);
  }

  // Get the agent/user information to include their name
  const agent = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      assignedToId: userId,
      status: "ACTIVE",
      visibleInDashboard: true, // Ensure visible when agent takes over
    },
  });

  // Broadcast agent assignment
  socketService.broadcastAgentAssigned(conversationId, userId);

  // Send system message with agent name
  const agentName = agent?.name || "A support agent";
  const systemMessage = await prisma.message.create({
    data: {
      conversationId,
      role: "SYSTEM",
      content: `${agentName} has joined the conversation.`,
    },
  });

  // Broadcast system message
  socketService.broadcastMessage(conversationId, systemMessage);

  // Send webhook for human handoff
  await webhookService.sendWebhook(
    conversation.workspaceId,
    webhookService.WEBHOOK_EVENTS.HUMAN_HANDOFF_REQUESTED,
    {
      conversationId: conversation.id,
      assignedToId: userId,
      visitorName: conversation.visitorName,
    }
  );

  return { success: true };
}

export async function resolveConversation(
  conversationId: string,
  rating?: number,
  feedback?: string
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId },
  });

  if (!conversation) {
    throw new ChatError("Conversation not found", 404);
  }

  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
      rating,
      feedback,
    },
  });

  // Send webhook for resolved conversation
  await webhookService.sendWebhook(
    conversation.workspaceId,
    webhookService.WEBHOOK_EVENTS.CONVERSATION_RESOLVED,
    {
      conversationId: conversation.id,
      visitorName: conversation.visitorName,
      rating,
      feedback,
    }
  );

  // Send webhook if rating is provided
  if (rating) {
    await webhookService.sendWebhook(
      conversation.workspaceId,
      webhookService.WEBHOOK_EVENTS.CONVERSATION_RATED,
      {
        conversationId: conversation.id,
        rating,
        feedback,
      }
    );

    // Send low satisfaction webhook if rating <= 2
    if (rating <= 2) {
      await webhookService.sendWebhook(
        conversation.workspaceId,
        webhookService.WEBHOOK_EVENTS.LOW_SATISFACTION,
        {
          conversationId: conversation.id,
          rating,
          feedback,
          visitorName: conversation.visitorName,
        }
      );
    }
  }

  return { success: true };
}

export async function getWorkspaceConversations(
  workspaceId: string,
  filters?: {
    status?: string;
    agentId?: string;
    assignedToId?: string;
  }
) {
  const where: any = {
    workspaceId,
    visibleInDashboard: true, // Only show conversations where human agent was requested
    ...(filters?.agentId && { agentId: filters.agentId }),
    ...(filters?.assignedToId && { assignedToId: filters.assignedToId }),
  };

  if (filters?.status) {
    if (filters.status === 'open') {
      where.status = { not: 'RESOLVED' };
    } else if (filters.status !== 'all') {
      where.status = filters.status.toUpperCase();
    }
  }

  const conversations = await prisma.conversation.findMany({
    where,
    include: {
      agent: {
        select: {
          id: true,
          name: true,
          avatarUrl: true,
        },
      },
      assignedTo: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
      _count: {
        select: {
          messages: true,
        },
      },
      // Get all messages to find URL and last message
      messages: {
        orderBy: {
          createdAt: 'desc'
        },
        select: {
          id: true,
          content: true,
          role: true,
          metadata: true,
          createdAt: true,
        },
      },
    },
    orderBy: {
      lastMessageAt: "desc",
    },
  });

  // Transform conversations to include currentPageUrl and lastMessage
  return conversations.map(conv => {
    let currentPageUrl = null;
    const lastMessage = conv.messages[0]; // First message in desc order = most recent

    // Find the most recent message with a URL (check all messages)
    for (const message of conv.messages) {
      if (message.role === 'USER' && message.metadata && typeof message.metadata === 'object') {
        const metadata = message.metadata as any;
        if (metadata.currentPageUrl) {
          currentPageUrl = metadata.currentPageUrl;
          logger.info('🔍 Found URL for conversation', { conversationId: conv.id, currentPageUrl });
          break; // Found the most recent URL, stop looking
        }
      }
    }

    return {
      ...conv,
      currentPageUrl,
      messageCount: conv._count.messages,
      lastMessage: lastMessage ? {
        content: lastMessage.content,
        sender: lastMessage.role.toLowerCase(),
      } : undefined,
      // Remove the messages array and _count to match expected interface
      messages: undefined,
      _count: undefined,
    };
  });
}

/**
 * Detect if user message is requesting a human agent
 */
function detectHumanAgentRequest(message: string): boolean {
  const lowerMessage = message.toLowerCase();

  const patterns = [
    // Dutch
    /\b(wil|kan|mag)\s+(ik\s+)?(graag\s+)?(met\s+)?(een\s+)?medewerker\b/i,
    /\bmedewerker\s+spreken\b/i,
    /\becht\s+iemand\b/i,
    /\bmens\s+spreken\b/i,
    /\blevend\s+persoon\b/i,
    /\becht\s+persoon\b/i,
    // English
    /\bhuman\s+agent\b/i,
    /\breal\s+person\b/i,
    /\bspeak\s+(to|with)\s+(a\s+)?human\b/i,
    /\btalk\s+to\s+(a\s+)?(human|person|agent|representative)\b/i,
    /\bconnect\s+(me\s+)?(to|with)\s+(a\s+)?(human|agent|representative)\b/i,
    /\btransfer\s+(me\s+)?(to|with)\s+(a\s+)?(human|agent)\b/i,
    /\bcustomer\s+(service|support)\b/i,
  ];

  return patterns.some(pattern => pattern.test(lowerMessage));
}

/**
 * Detect if user question is about competitors
 */
function detectCompetitorQuestion(message: string): boolean {
  const lowerMessage = message.toLowerCase();

  const patterns = [
    // Dutch
    /\bconcurrent(en|ie)?\b/i,
    /\bandere\s+(bedrijven|partijen|leveranciers|aanbieders)\b/i,
    /\bvergelijk(en|ing)?\s+(met|tussen)\b/i,
    /\b(wat|waarom)\s+(zijn|is)\s+jullie\s+beter\s+dan\b/i,
    /\bverschil\s+(tussen|met)\b/i,
    // English
    /\bcompetitor(s)?\b/i,
    /\bother\s+(companies|businesses|vendors|providers)\b/i,
    /\bcompare\s+(to|with|against)\b/i,
    /\bwhy\s+(are\s+you|is\s+\w+)\s+better\s+than\b/i,
    /\bdifference\s+(between|with)\b/i,
    /\balternative(s)?\s+to\b/i,
    /\bvs\b/i,
    /\bversus\b/i,
  ];

  return patterns.some(pattern => pattern.test(lowerMessage));
}

/**
 * Check if human agents are available
 */
async function checkAgentAvailability(
  workspaceId: string,
  widgetId: string | null
): Promise<{ available: boolean; reason?: string; message: string }> {
  // Get widget configuration if widgetId is provided
  let widget = null;
  if (widgetId) {
    widget = await prisma.widget.findUnique({
      where: { id: widgetId },
      select: {
        aiOnlyMode: true,
        aiOnlyMessage: true,
        workingHours: true,
        holidays: true,
      },
    });
  }

  // Check AI-only mode
  if (widget?.aiOnlyMode) {
    const message = (widget.aiOnlyMessage as any)?.nl ||
      "Sorry, op dit moment zijn er geen medewerkers beschikbaar. Ik help je graag verder!";
    return {
      available: false,
      reason: "ai_only_mode",
      message,
    };
  }

  // Check holidays
  if (widget?.holidays) {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const holidays = widget.holidays as any[];
    const isHoliday = holidays.some((h: any) => h.date === today);

    if (isHoliday) {
      return {
        available: false,
        reason: "holiday",
        message: "Sorry, vandaag is het een feestdag. We zijn gesloten. Ik help je graag verder!",
      };
    }
  }

  // Check working hours
  if (widget?.workingHours) {
    const now = new Date();
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const currentDay = dayNames[now.getDay()];
    const currentTime = now.toTimeString().slice(0, 5); // HH:MM format

    const workingHours = widget.workingHours as any;
    const todayHours = workingHours[currentDay];

    if (!todayHours?.enabled || currentTime < todayHours.start || currentTime > todayHours.end) {
      return {
        available: false,
        reason: "outside_working_hours",
        message: "Sorry, we zijn op dit moment buiten onze werktijden. Ik help je graag verder!",
      };
    }
  }

  // Check if there are online agents
  const onlineCount = await presenceService.getWorkspaceOnlineCount(workspaceId);

  if (onlineCount === 0) {
    return {
      available: false,
      reason: "no_agents_online",
      message: "Sorry, er zijn momenteel geen medewerkers online. Ik help je graag verder!",
    };
  }

  return {
    available: true,
    message: "Een medewerker neemt zo contact met je op.",
  };
}
