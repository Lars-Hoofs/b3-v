import { prisma } from "../lib/prisma";
import { nanoid } from "nanoid";
import { CreateWidgetInput } from '../routes/widget.routes';

export class WidgetError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = "WidgetError";
  }
}


export async function createWidget(input: CreateWidgetInput) {
  // Verify agent exists and belongs to workspace
  const agent = await prisma.agent.findFirst({
    where: {
      id: input.agentId,
      workspaceId: input.workspaceId,
      deletedAt: null,
    },
  });

  if (!agent) {
    throw new WidgetError("Agent not found in this workspace", 404);
  }

  // Generate unique install code
  const installCode = nanoid(16);

  // Extract all widget fields from input
  const { workspaceId, agentId, name, ...widgetConfig } = input;

  const widget = await prisma.widget.create({
    data: {
      workspaceId,
      agentId,
      name,
      widgetType: widgetConfig.widgetType || "bubble",
      position: widgetConfig.position || "bottom-right",
      offsetX: widgetConfig.offsetX || 20,
      offsetY: widgetConfig.offsetY || 20,
      primaryColor: widgetConfig.primaryColor || "#000000",
      theme: widgetConfig.theme || "light",

      // Advanced Launcher Builder
      launcherMode: widgetConfig.launcherMode || "simple",
      launcherStructure: widgetConfig.launcherStructure,

      // Advanced Chat Builder
      chatMode: widgetConfig.chatMode || "simple",
      chatStructure: widgetConfig.chatStructure,

      // Bubble customization
      bubbleIcon: widgetConfig.bubbleIcon || "RiChat1Fill",
      bubbleText: widgetConfig.bubbleText,
      bubbleShape: widgetConfig.bubbleShape || "circle",
      bubbleSize: widgetConfig.bubbleSize || "medium",
      bubbleWidth: widgetConfig.bubbleWidth,
      bubbleHeight: widgetConfig.bubbleHeight,
      bubbleBackgroundColor: widgetConfig.bubbleBackgroundColor || "#000000",
      bubbleTextColor: widgetConfig.bubbleTextColor || "#ffffff",

      // Chat window
      chatWidth: widgetConfig.chatWidth || 380,
      chatHeight: widgetConfig.chatHeight || 650,
      chatBorderRadius: widgetConfig.chatBorderRadius || 24,

      // Header
      headerTitle: widgetConfig.headerTitle || "Chat Assistant",
      headerSubtitle: widgetConfig.headerSubtitle || "Ask me anything",
      headerBackgroundColor: widgetConfig.headerBackgroundColor || "#ffffff",
      headerTextColor: widgetConfig.headerTextColor || "#000000",

      // Messages
      userMessageColor: widgetConfig.userMessageColor || "#000000",
      userMessageTextColor: widgetConfig.userMessageTextColor || "#ffffff",
      botMessageColor: widgetConfig.botMessageColor || "#f3f4f6", // Zinc-100
      botMessageTextColor: widgetConfig.botMessageTextColor || "#111827", // Zinc-900
      messageBorderRadius: widgetConfig.messageBorderRadius || 16,

      // Behavior
      greeting: widgetConfig.greeting || "Hey there!\n\nNeed answers or help with your to-do list? I've got you covered!\n\nJust type what you need, and let's dive into making things happen.",
      placeholder: widgetConfig.placeholder || "Type here...",
      suggestedQuestions: widgetConfig.suggestedQuestions || [],
      autoOpen: widgetConfig.autoOpen ?? false,
      autoOpenDelay: widgetConfig.autoOpenDelay || 5000,

      // Branding & advanced
      showBranding: widgetConfig.showBranding ?? false, // Cleaner by default
      customCss: widgetConfig.customCss,
      allowedDomains: widgetConfig.allowedDomains || [],
      zIndex: widgetConfig.zIndex || 999999,

      installCode,
    },
    include: {
      agent: {
        select: {
          id: true,
          name: true,
          avatarUrl: true,
        },
      },
    },
  });

  return widget;
}

export async function getWidget(widgetId: string, workspaceId: string) {
  const widget = await prisma.widget.findFirst({
    where: {
      id: widgetId,
      workspaceId,
      deletedAt: null,
    },
    include: {
      agent: true,
      _count: {
        select: {
          conversations: true,
        },
      },
    },
  });

  if (!widget) {
    throw new WidgetError("Widget not found", 404);
  }

  return widget;
}

export async function getWidgetByInstallCode(installCode: string) {
  const widget = await prisma.widget.findFirst({
    where: {
      installCode,
      isActive: true,
      deletedAt: null,
    },
    include: {
      agent: {
        include: {
          knowledgeBase: true,
          workflow: true,
        },
      },
      workspace: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  if (!widget) {
    throw new WidgetError("Widget not found or inactive", 404);
  }

  return widget;
}

export async function getWorkspaceWidgets(workspaceId: string) {
  return prisma.widget.findMany({
    where: {
      workspaceId,
      deletedAt: null,
    },
    include: {
      agent: {
        select: {
          id: true,
          name: true,
          avatarUrl: true,
        },
      },
      _count: {
        select: {
          conversations: true,
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });
}

export async function updateWidget(
  widgetId: string,
  workspaceId: string,
  data: Partial<CreateWidgetInput>
) {
  const widget = await prisma.widget.findFirst({
    where: {
      id: widgetId,
      workspaceId,
      deletedAt: null,
    },
  });

  if (!widget) {
    throw new WidgetError("Widget not found", 404);
  }

  // Prepare update data
  const updateData: any = { ...data };

  // If changing agent, verify new agent exists and use nested update
  if (data.agentId) {
    const agent = await prisma.agent.findFirst({
      where: {
        id: data.agentId,
        workspaceId,
        deletedAt: null,
      },
    });

    if (!agent) {
      throw new WidgetError("Agent not found in this workspace", 404);
    }

    // Convert agentId to nested relation update
    updateData.agent = {
      connect: { id: data.agentId }
    };
    delete updateData.agentId;
  }

  // Remove workspaceId from update data if present
  delete updateData.workspaceId;

  return prisma.widget.update({
    where: { id: widgetId },
    data: updateData,
  });
}

export async function deleteWidget(widgetId: string, workspaceId: string) {
  const widget = await prisma.widget.findFirst({
    where: {
      id: widgetId,
      workspaceId,
      deletedAt: null,
    },
  });

  if (!widget) {
    throw new WidgetError("Widget not found", 404);
  }

  // Soft delete
  await prisma.widget.update({
    where: { id: widgetId },
    data: { deletedAt: new Date(), isActive: false },
  });

  return { success: true };
}

export async function toggleWidgetStatus(
  widgetId: string,
  workspaceId: string,
  isActive: boolean
) {
  const widget = await prisma.widget.findFirst({
    where: {
      id: widgetId,
      workspaceId,
      deletedAt: null,
    },
  });

  if (!widget) {
    throw new WidgetError("Widget not found", 404);
  }

  return prisma.widget.update({
    where: { id: widgetId },
    data: { isActive },
  });
}

export function generateEmbedCode(installCode: string, apiUrl: string): string {
  return `<!-- AI Chat Widget -->
<script>
  (function() {
    window.aiChatConfig = {
      installCode: "${installCode}",
      apiUrl: "${apiUrl}"
    };
    var script = document.createElement('script');
    script.src = "${apiUrl}/widget.js";
    script.async = true;
    document.head.appendChild(script);
  })();
</script>`;
}
