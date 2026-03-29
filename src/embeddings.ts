import type { EmbedProvider } from './types.js';

export interface IEmbeddingFunction {
  generate(texts: string[]): Promise<number[][]>;
}

/**
 * Factory — returns a ChromaDB-compatible embedding function.
 * Provider priority mirrors Python chroma_index.py _build_embedding_function().
 */
export async function createEmbeddingFunction(
  provider: EmbedProvider,
  model: string,
  ollamaUrl: string,
  openaiApiKey?: string,
): Promise<IEmbeddingFunction> {
  if (provider === 'openai') {
    const { OpenAIEmbeddingFunction } = await import('chromadb');
    if (!openaiApiKey) throw new Error('OPENAI_API_KEY is required for openai embed provider');
    return new OpenAIEmbeddingFunction({
      openai_api_key: openaiApiKey,
      openai_model: model || 'text-embedding-3-small',
    }) as unknown as IEmbeddingFunction;
  }

  if (provider === 'fastembed') {
    const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
    // Use BGESmallENV15 as default; caller can pass any EmbeddingModel key
    const modelKey = (model in EmbeddingModel)
      ? EmbeddingModel[model as keyof typeof EmbeddingModel]
      : EmbeddingModel.BGESmallENV15;
    const embedder = await FlagEmbedding.init({ model: modelKey });
    return {
      generate: async (texts: string[]): Promise<number[][]> => {
        const result: number[][] = [];
        for await (const batch of embedder.embed(texts)) {
          // batch is Float32Array[] or number[][] depending on version
          for (const vec of batch as unknown as (Float32Array | number[])[]) {
            result.push(Array.from(vec));
          }
        }
        return result;
      },
    };
  }

  // Default: ollama
  const { OllamaEmbeddingFunction } = await import('chromadb');
  return new OllamaEmbeddingFunction({
    url: `${ollamaUrl}/api/embeddings`,
    model: model || 'nomic-embed-text',
  }) as unknown as IEmbeddingFunction;
}
