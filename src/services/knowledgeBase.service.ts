import { prisma } from "../lib/prisma";
import OpenAI from "openai";
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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});


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
    console.error("Document processing error:", error);
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
    // Split content into chunks
    const chunks = splitTextIntoChunks(document.content, chunkSize, chunkOverlap);

    // Generate embeddings and save chunks one by one
    // We can't use createMany because pgvector doesn't support it
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      const embedding = await generateEmbedding(chunk.text, embeddingModel);

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
          ${index},
          ${chunk.startChar},
          ${chunk.endChar},
          ${JSON.stringify({ chunkLength: chunk.text.length })}::jsonb,
          NOW()
        )
      `;
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

function splitTextIntoChunks(
  text: string,
  chunkSize: number,
  overlap: number
): Array<{ text: string; startChar: number; endChar: number }> {
  const chunks: Array<{ text: string; startChar: number; endChar: number }> = [];

  // Recursive character splitter implementation
  // We explicitly want to split on these separators in order of precedence
  const separators = ["\n\n", "\n", ". ", "! ", "? ", ";", ":", " ", ""];

  function splitRecursive(
    currentText: string,
    currentStartOffset: number
  ): void {
    const length = currentText.length;

    // If text fits in a chunk, just add it
    if (length <= chunkSize) {
      if (length > 0) {
        chunks.push({
          text: currentText,
          startChar: currentStartOffset,
          endChar: currentStartOffset + length
        });
      }
      return;
    }

    // Otherwise, we leverage separators to find the best split point
    let bestSplitIndex = -1;
    let separatorUsed = '';

    for (const separator of separators) {
      if (separator === "") {
        // If we get to the empty separator, we just hard split at chunkSize
        bestSplitIndex = chunkSize;
        separatorUsed = "";
        break;
      }

      // Find the last occurrence of the separator within the chunkSize limit
      // We want to maximize the chunk size while respecting semantic boundaries
      const firstPart = currentText.substring(0, chunkSize + separator.length); // look a bit past to find the separator
      const lastIndex = firstPart.lastIndexOf(separator);

      if (lastIndex !== -1 && lastIndex < chunkSize) {
        bestSplitIndex = lastIndex;
        separatorUsed = separator;
        break;
      }
    }

    // If for some reason we couldn't find a split (shouldn't happen with "" separator), force split
    if (bestSplitIndex === -1) {
      bestSplitIndex = chunkSize;
    }

    // Add the first part
    const chunkText = currentText.substring(0, bestSplitIndex + separatorUsed.length);
    chunks.push({
      text: chunkText,
      startChar: currentStartOffset,
      endChar: currentStartOffset + chunkText.length
    });

    // Calculate overlap start for the next chunk
    // We want the next chunk to include some of the previous text for context
    let nextStartInCurrent = bestSplitIndex + separatorUsed.length;

    // Apply overlap by backtracking, but try to respect boundaries again?
    // For simplicity in this robust implementation, we just effectively shift the window
    // However, true overlap means we need to "unread" some characters or just send the rest
    // Standard recursive splitters usually just recurse on the rest.
    // To support overlap, we actually need a sliding window approach.

    // Let's switch to a simpler Sliding Window approach with Semantic boundaries which is more robust for RAG.
  }

  // --- Better Sliding Window Implementation ---

  let currentStart = 0;

  while (currentStart < text.length) {
    // 1. Determine potential end based on chunkSize
    let potentialEnd = Math.min(currentStart + chunkSize, text.length);
    let chunkEnd = potentialEnd;

    // 2. If we are not at the end of the text, try to walk back to the nearest separator
    if (chunkEnd < text.length) {
      let foundSeparator = false;
      for (const sep of separators) {
        if (sep === "") continue;

        // Search backwards from potentialEnd
        // We look back up to 'overlap' distance or reasonable amount to find a break
        const searchWindow = text.substring(Math.max(currentStart, potentialEnd - 100), potentialEnd + sep.length);
        const lastIndexOfSep = searchWindow.lastIndexOf(sep);

        if (lastIndexOfSep !== -1) {
          // Adjust position relative to original text
          const relativeIndex = Math.max(currentStart, potentialEnd - 100) + lastIndexOfSep + sep.length;
          if (relativeIndex > currentStart && relativeIndex <= potentialEnd + sep.length) {
            chunkEnd = relativeIndex;
            foundSeparator = true;
            break;
          }
        }
      }
    }

    const chunkText = text.slice(currentStart, chunkEnd);
    chunks.push({
      text: chunkText,
      startChar: currentStart,
      endChar: chunkEnd
    });

    // 3. Move start pointer forward, considering overlap
    // New start should be (currentEnd - overlap)
    // BUT we should also try to align the NEW start with a semantic boundary so we don't start in the middle of a word

    if (chunkEnd >= text.length) break;

    let nextStart = chunkEnd - overlap;

    // If overlap brings us back before currentStart, force forward progress
    if (nextStart <= currentStart) {
      nextStart = currentStart + Math.floor(chunkSize / 2);
    }

    // Refine nextStart: try to find a sentence/word boundary *before* the calculated nextStart
    // to ensure the overlap creates a clean start for the next chunk
    let refinedNextStart = nextStart;
    const lookbackRange = 50; // Text to look at around the overlap point
    const overlapWindow = text.substring(Math.max(0, nextStart - lookbackRange), Math.min(text.length, nextStart + lookbackRange));

    // Try to find a sentence break near the overlap point
    for (const sep of ["\n\n", "\n", ". ", "? ", "! "]) {
      const idx = overlapWindow.indexOf(sep);
      if (idx !== -1) {
        // Calculate absolute position
        const absIndex = Math.max(0, nextStart - lookbackRange) + idx + sep.length;
        // Ideally we want the start to be as close to 'nextStart' as possible, or slightly before
        // This is a heuristic. Simpler is just to stick to the hard overlap or standard slicing.
        // Let's simple-slide for now, the "End" optimization is the most important for reading quality.
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
): Promise<Array<{ content: string; score: number; documentTitle: string; sourceUrl: string | null; chunkId: string }>> {
  // Generate embedding for query
  const kb = await prisma.knowledgeBase.findUnique({
    where: { id: knowledgeBaseId },
  });

  if (!kb) {
    throw new KnowledgeBaseError("Knowledge base not found", 404);
  }

  const queryEmbedding = await generateEmbedding(query, kb.embeddingModel);
  const vectorString = `[${queryEmbedding.join(',')}]`;

  // Use pgvector for efficient cosine similarity search
  // The <=> operator computes cosine distance (1 - cosine similarity)
  // We order by distance ASC to get most similar chunks first
  const results = await prisma.$queryRaw<
    Array<{
      id: string;
      content: string;
      distance: number;
      title: string;
      sourceUrl: string | null;
    }>
  >`
    SELECT 
      dc.id,
      dc.content,
      dc.embedding <=> ${vectorString}::vector(1536) as distance,
      d.title,
      d."sourceUrl"
    FROM "document_chunks" dc
    INNER JOIN "documents" d ON dc."documentId" = d.id
    WHERE d."knowledgeBaseId" = ${knowledgeBaseId}
      AND d.status = 'COMPLETED'
      AND dc.embedding IS NOT NULL
    ORDER BY dc.embedding <=> ${vectorString}::vector(1536)
    LIMIT ${limit}
  `;

  // Convert distance to similarity score (1 - distance)
  // Since cosine distance = 1 - cosine similarity
  return results.map((result) => ({
    chunkId: result.id,
    content: result.content,
    score: 1 - result.distance, // Convert distance back to similarity
    documentTitle: result.title,
    sourceUrl: result.sourceUrl,
  }));
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
