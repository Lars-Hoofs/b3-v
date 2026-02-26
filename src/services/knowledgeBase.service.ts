import { prisma } from "../lib/prisma";
import logger from "../lib/logger";
import { openai } from "../lib/openai";
import crypto from 'crypto';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { Cache } from "../lib/redis";
import { CreateKnowledgeBaseInput, CreateDocumentInput } from '../routes/knowledgeBase.routes';

export class KnowledgeBaseError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = "KnowledgeBaseError";
  }
}


export async function createKnowledgeBase(input: CreateKnowledgeBaseInput) {
  const workspace = await prisma.workspace.findFirst({
    where: { id: input.workspaceId, deletedAt: null },
  });

  if (!workspace) {
    throw new KnowledgeBaseError("Workspace not found", 404);
  }

  return prisma.knowledgeBase.create({
    data: {
      workspaceId: input.workspaceId,
      name: input.name,
      description: input.description,
      embeddingModel: input.embeddingModel || "text-embedding-3-small",
      chunkSize: input.chunkSize || 1000,
      chunkOverlap: input.chunkOverlap || 200,
    },
  });
}

export async function getKnowledgeBase(kbId: string, workspaceId: string) {
  const kb = await prisma.knowledgeBase.findFirst({
    where: {
      id: kbId,
      workspaceId,
      deletedAt: null,
    },
    include: {
      documents: {
        where: { status: "COMPLETED" },
        orderBy: { createdAt: "desc" },
      },
      _count: {
        select: { documents: true },
      },
    },
  });

  if (!kb) {
    throw new KnowledgeBaseError("Knowledge base not found", 404);
  }

  return kb;
}

export async function getWorkspaceKnowledgeBases(workspaceId: string) {
  return prisma.knowledgeBase.findMany({
    where: {
      workspaceId,
      deletedAt: null,
    },
    include: {
      _count: {
        select: { documents: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function deleteKnowledgeBase(kbId: string, workspaceId: string) {
  const kb = await prisma.knowledgeBase.findFirst({
    where: { id: kbId, workspaceId, deletedAt: null },
  });

  if (!kb) {
    throw new KnowledgeBaseError("Knowledge base not found", 404);
  }

  // Check if any agents are using this KB
  const agentsUsingKB = await prisma.agent.count({
    where: {
      knowledgeBaseId: kbId,
      deletedAt: null,
    },
  });

  if (agentsUsingKB > 0) {
    throw new KnowledgeBaseError(
      `Cannot delete knowledge base. ${agentsUsingKB} agent(s) are using it.`,
      400
    );
  }

  // Soft delete
  await prisma.knowledgeBase.update({
    where: { id: kbId },
    data: { deletedAt: new Date() },
  });

  return { success: true };
}

export async function getKnowledgeBaseDocuments(kbId: string) {
  const documents = await prisma.document.findMany({
    where: {
      knowledgeBaseId: kbId,
    },
    select: {
      id: true,
      title: true,
      content: true,
      sourceUrl: true,
      fileUrl: true,
      status: true,
      chunkCount: true,
      createdAt: true,
      metadata: true,
      tags: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  // Transform to add sourceType based on available data
  return documents.map(doc => ({
    ...doc,
    sourceType: doc.sourceUrl ? 'SCRAPE' : 'UPLOAD',
    uploadedFileName: doc.fileUrl ? doc.fileUrl.split('/').pop() : null,
  }));
}


export async function createDocument(input: CreateDocumentInput) {
  const kb = await prisma.knowledgeBase.findFirst({
    where: { id: input.knowledgeBaseId, deletedAt: null },
  });

  if (!kb) {
    throw new KnowledgeBaseError("Knowledge base not found", 404);
  }

  // Create document with PENDING status
  const document = await prisma.document.create({
    data: {
      knowledgeBaseId: input.knowledgeBaseId,
      title: input.title,
      content: input.content,
      sourceUrl: input.sourceUrl,
      metadata: input.metadata,
      tags: input.tags || [],
      status: "PROCESSING",
    },
  });

  // Process document asynchronously
  processDocument(document.id, kb.chunkSize, kb.chunkOverlap, kb.embeddingModel).catch((error) => {
    logger.error("Document processing error", { error: error.message });
    prisma.document.update({
      where: { id: document.id },
      data: {
        status: "FAILED",
        errorMessage: error.message,
      },
    });
  });

  return document;
}

export async function processDocument(
  documentId: string,
  chunkSize: number,
  chunkOverlap: number,
  embeddingModel: string
) {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
  });

  if (!document) return;

  try {
    let parsedContent = document.content;

    // Check if we need to parse a file
    if (document.fileUrl) {
      try {
        const response = await fetch(document.fileUrl);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const mimeType = document.mimeType || '';
        const fileUrlLower = document.fileUrl.toLowerCase();

        if (mimeType.includes("pdf") || fileUrlLower.endsWith('.pdf')) {
          const pdfData = await (pdfParse as any)(buffer);
          parsedContent = pdfData.text;
        } else if (
          mimeType.includes("msword") ||
          mimeType.includes("wordprocessingml") ||
          fileUrlLower.endsWith('.docx') ||
          fileUrlLower.endsWith('.doc')
        ) {
          const result = await mammoth.extractRawText({ buffer });
          parsedContent = result.value;
        }

        // Update document with parsed content
        if (parsedContent !== document.content) {
          await prisma.document.update({
            where: { id: document.id },
            data: { content: parsedContent }
          });
        }
      } catch (parseError: any) {
        logger.error("Error parsing document file via URL", { error: parseError.message, documentId });
        // Fallback to existing content or empty
        parsedContent = document.content || "";
      }
    }

    // Split content into chunks
    const chunks = splitTextIntoChunks(parsedContent, chunkSize, chunkOverlap);

    // Generate batched embeddings
    const batchSize = 100;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);

      const response = await openai.embeddings.create({
        model: embeddingModel,
        input: batch.map(c => c.text),
      });

      // Save chunks one by one
      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const embedding = response.data[j].embedding;
        const globalIndex = i + j;

        // Convert embedding array to pgvector string format: '[0.1, 0.2, ...]'
        const vectorString = `[${embedding.join(',')}]`;

        // Insert with raw SQL to use pgvector
        await prisma.$executeRaw`
          INSERT INTO "document_chunks" (
            "id", "documentId", "content", "embedding", 
            "chunkIndex", "startChar", "endChar", "metadata", "createdAt"
          ) VALUES (
            gen_random_uuid()::text,
            ${document.id},
            ${chunk.text},
            ${vectorString}::vector(1536),
            ${globalIndex},
            ${chunk.startChar},
            ${chunk.endChar},
            ${JSON.stringify({ chunkLength: chunk.text.length })}::jsonb,
            NOW()
          )
        `;
      }
    }

    // Update document status
    await prisma.document.update({
      where: { id: documentId },
      data: {
        status: "COMPLETED",
        chunkCount: chunks.length,
      },
    });
  } catch (error: any) {
    await prisma.document.update({
      where: { id: documentId },
      data: {
        status: "FAILED",
        errorMessage: error.message,
      },
    });
    throw error;
  }
}

function splitTextIntoChunks(text: string, chunkSize: number, overlap: number): Array<{ text: string, startChar: number, endChar: number }> {
  const chunks: Array<{ text: string, startChar: number, endChar: number }> = [];
  if (!text || text.trim().length === 0) return chunks;

  const separators = ["\n\n", "\n", ". ", "? ", "! ", "; ", " ", ""];
  let currentStart = 0;

  while (currentStart < text.length) {
    let currentEnd = Math.min(currentStart + chunkSize, text.length);
    let chunkEnd = currentEnd;

    // If we're not at the end, find the best semantic break point looking backwards
    if (currentEnd < text.length) {
      // Look back up to half a chunk size to find a clean break
      const lookBackLimit = Math.max(currentStart + Math.floor(chunkSize / 2), currentEnd - Math.floor(chunkSize / 2));
      const searchWindow = text.substring(lookBackLimit, currentEnd);

      let foundBreak = false;
      for (const sep of separators) {
        if (sep === "") {
          chunkEnd = currentEnd; // Hard fallback
          break;
        }

        const lastIdx = searchWindow.lastIndexOf(sep);
        if (lastIdx !== -1) {
          chunkEnd = lookBackLimit + lastIdx + sep.length;
          foundBreak = true;
          break;
        }
      }
    }

    const chunkText = text.substring(currentStart, chunkEnd).trim();
    if (chunkText.length > 0) {
      chunks.push({
        text: chunkText,
        startChar: currentStart,
        endChar: currentStart + chunkText.length
      });
    }

    if (chunkEnd >= text.length) {
      break;
    }

    // Advance currentStart with overlap
    let nextStart = chunkEnd - overlap;

    if (nextStart <= currentStart) {
      nextStart = currentStart + Math.floor(chunkSize / 2);
    }

    // Attempt to align the overlap start to a cleaner semantic boundary forward
    const lookAheadWindow = text.substring(Math.max(0, nextStart - 50), Math.min(text.length, nextStart + 50));
    let adjustedStart = nextStart;

    for (const sep of ["\n\n", "\n", ". ", "? ", "! "]) {
      const breakIdx = lookAheadWindow.indexOf(sep);
      if (breakIdx !== -1) {
        adjustedStart = Math.max(0, nextStart - 50) + breakIdx + sep.length;
        if (adjustedStart > currentStart && adjustedStart < chunkEnd) {
          nextStart = adjustedStart;
          break;
        }
      }
    }

    currentStart = nextStart;
  }

  return chunks;
}

async function generateEmbedding(text: string, model: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: model,
    input: text,
  });

  return response.data[0].embedding;
}

export async function searchKnowledgeBase(
  knowledgeBaseId: string,
  query: string,
  limit: number = 5
) {
  const kb = await prisma.knowledgeBase.findUnique({
    where: { id: knowledgeBaseId },
  });

  if (!kb) {
    throw new KnowledgeBaseError("Knowledge base not found", 404);
  }

  // Generate cache key
  const queryHash = crypto.createHash("md5").update(query).digest("hex");
  const cacheKey = `kb:search:${knowledgeBaseId}:${queryHash}:${limit}`;

  // Check cache first
  const cachedResults = await Cache.get<Array<{ content: string; score: number; documentTitle: string; sourceUrl: string | null; chunkId: string }>>(cacheKey);
  if (cachedResults) {
    logger.info('Cache hit for knowledge base search', { baseId: knowledgeBaseId, query: cacheKey });
    return cachedResults;
  }

  const queryEmbedding = await generateEmbedding(query, kb.embeddingModel);
  const vectorString = `[${queryEmbedding.join(',')}]`;

  // Format query for PostgreSQL full-text search (BM25 style)
  // Convert "What is Product X?" to "What | is | Product | X"
  const ftsQuery = query.replace(/[^\w\s]/g, '').trim().split(/\s+/).join(' | ');

  // Hybrid Search: Combine pgvector (Semantic) and tsvector (Keyword) via RRF
  // 1. Get Top 20 Semantic Matches
  // 2. Get Top 20 Keyword Matches
  // 3. Combine and re-score

  const results = await prisma.$queryRaw<
    Array<{
      id: string;
      content: string;
      distance: number;
      title: string;
      sourceUrl: string | null;
      semantic_rank: number;
      keyword_rank: number;
      hybrid_score: number;
    }>
  >`
    WITH semantic_search AS (
      SELECT 
        dc.id,
        dc.content,
        dc.embedding <=> ${vectorString}::vector(1536) as distance,
        d.title,
        d."sourceUrl",
        ROW_NUMBER() OVER (ORDER BY dc.embedding <=> ${vectorString}::vector(1536)) as semantic_rank
      FROM "document_chunks" dc
      INNER JOIN "documents" d ON dc."documentId" = d.id
      WHERE d."knowledgeBaseId" = ${knowledgeBaseId}
        AND d.status = 'COMPLETED'
        AND dc.embedding IS NOT NULL
      ORDER BY distance ASC
      LIMIT 20
    ),
    keyword_search AS (
      SELECT 
        dc.id,
        dc.content,
        0::float as distance,
        d.title,
        d."sourceUrl",
        ROW_NUMBER() OVER (ORDER BY ts_rank_cd(to_tsvector('english', dc.content), to_tsquery('english', ${ftsQuery})) DESC) as keyword_rank
      FROM "document_chunks" dc
      INNER JOIN "documents" d ON dc."documentId" = d.id
      WHERE d."knowledgeBaseId" = ${knowledgeBaseId}
        AND d.status = 'COMPLETED'
        AND ${ftsQuery} != ''
        AND to_tsvector('english', dc.content) @@ to_tsquery('english', ${ftsQuery})
      ORDER BY keyword_rank ASC
      LIMIT 20
    ),
    combined_results AS (
      SELECT 
        COALESCE(s.id, k.id) as id,
        COALESCE(s.content, k.content) as content,
        COALESCE(s.distance, 1.0) as distance,
        COALESCE(s.title, k.title) as title,
        COALESCE(s."sourceUrl", k."sourceUrl") as "sourceUrl",
        COALESCE(s.semantic_rank, 60) as semantic_rank,
        COALESCE(k.keyword_rank, 60) as keyword_rank
      FROM semantic_search s
      FULL OUTER JOIN keyword_search k ON s.id = k.id
    )
    SELECT
      id,
      content,
      distance,
      title,
      "sourceUrl",
      semantic_rank,
      keyword_rank,
      -- Reciprocal Rank Fusion (RRF) score: 1 / (60 + rank)
      -- Higher score is better
      (1.0 / (60.0 + semantic_rank)) + (1.0 / (60.0 + keyword_rank)) as hybrid_score
    FROM combined_results
    ORDER BY hybrid_score DESC
    LIMIT ${limit}
  `;

  // Provide a generous MIN_SIMILARITY threshold because hybrid RRF scores are naturally lower floats
  const MIN_SIMILARITY = 0.005; // Adjusted for RRF (typical max is ~0.033)

  // Convert distance to similarity score
  let filteredResults = results
    .map((result) => ({
      chunkId: result.id,
      content: result.content,
      score: result.hybrid_score, // Use the new RRF hybrid score
      documentTitle: result.title,
      sourceUrl: result.sourceUrl,
    }))
    .filter((result) => result.score >= MIN_SIMILARITY);

  // --- LLM Cross-Encoder Re-Ranking ---
  // If we have more results than the limit, we'll ask the LLM to judge relevance
  if (filteredResults.length > limit) {
    try {
      const { generateChatCompletion } = await import("../lib/openai");

      const chunksData = filteredResults.map((r, i) => `[ID: ${i}] ${r.content}`).join("\n\n---\n\n");
      const rerankPrompt = `You are an expert system that re-ranks search results based on a user's query.\n\nQuery: "${query}"\n\nAnalyze the following document chunks and score their relevance to the query from 0 to 10 (10 being a perfect direct answer, 0 being completely irrelevant).\n\nChunks:\n${chunksData}\n\nReturn EXACTLY a JSON array of objects, with each object containing "id" (the chunk ID integer) and "score" (your 0-10 relevance score). Do NOT return markdown formatting like \`\`\`json. Just the raw JSON array.`;

      const rerankResponse = await generateChatCompletion([
        { role: "system", content: "You are a JSON-only API. Only output valid JSON arrays." },
        { role: "user", content: rerankPrompt }
      ], "gpt-4o-mini", { temperature: 0, max_tokens: 1000 });

      let llmScores: Array<{ id: number, score: number }> = [];
      try {
        const rawContent = rerankResponse.choices?.[0]?.message?.content?.trim() || "[]";
        // Clean up any accidental markdown
        const cleanJson = rawContent.replace(/^```json\s*/, '').replace(/```$/, '').trim();
        llmScores = JSON.parse(cleanJson);

        // Map the LLM scores back to our results
        if (Array.isArray(llmScores)) {
          filteredResults = filteredResults.map((result, index) => {
            const llmJudge = llmScores.find(s => s.id === index);
            if (llmJudge && typeof llmJudge.score === 'number') {
              // Override the hybrid score with the much smarter LLM score
              return { ...result, score: llmJudge.score };
            }
            return { ...result, score: 0 }; // Demote if the LLM didn't score it
          });

          // Re-sort descending and apply the final strict limit limit
          filteredResults = filteredResults
            .sort((a, b) => b.score - a.score)
            .filter(r => r.score > 2) // Must be at least somewhat relevant
            .slice(0, limit);

          logger.info("LLM Re-Ranking applied successfully", { baseId: knowledgeBaseId, originalCount: results.length, finalCount: filteredResults.length });
        }
      } catch (jsonErr) {
        logger.warn("LLM Re-Ranking returned invalid JSON, falling back to raw Hybrid Search", { baseId: knowledgeBaseId, error: jsonErr });
        filteredResults = filteredResults.slice(0, limit);
      }
    } catch (rerankErr) {
      logger.warn("LLM Re-Ranking failed, falling back to raw Hybrid Search", { baseId: knowledgeBaseId, error: rerankErr });
      filteredResults = filteredResults.slice(0, limit);
    }
  } else {
    filteredResults = filteredResults.slice(0, limit);
  }

  // Store in cache for 10 minutes (600 seconds)
  try {
    if (filteredResults.length > 0) {
      await Cache.set(cacheKey, filteredResults, 600);
    }
  } catch (cacheErr) {
    logger.error('Failed to set cache for knowledge base search', { baseId: knowledgeBaseId, query: cacheKey, error: cacheErr });
  }

  return filteredResults;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (magnitudeA * magnitudeB);
}

export async function getDocument(documentId: string, workspaceId: string) {
  const document = await prisma.document.findFirst({
    where: {
      id: documentId,
      knowledgeBase: {
        workspaceId,
      },
    },
    include: {
      knowledgeBase: {
        select: {
          id: true,
          name: true,
        },
      },
      chunks: {
        select: {
          id: true,
          chunkIndex: true,
          content: true,
        },
        orderBy: {
          chunkIndex: "asc",
        },
      },
    },
  });

  if (!document) {
    throw new KnowledgeBaseError("Document not found", 404);
  }

  return document;
}

export async function deleteDocument(documentId: string, workspaceId: string) {
  const document = await prisma.document.findFirst({
    where: {
      id: documentId,
      knowledgeBase: {
        workspaceId,
      },
    },
  });

  if (!document) {
    throw new KnowledgeBaseError("Document not found", 404);
  }

  // Delete chunks first
  await prisma.documentChunk.deleteMany({
    where: { documentId },
  });

  // Delete document
  await prisma.document.delete({
    where: { id: documentId },
  });

  return { success: true };
}
