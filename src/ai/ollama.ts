/**
 * @module ai/ollama
 * Ollama client for local AI-powered network analysis.
 *
 * Uses Ollama to run LLMs locally for analyzing BGP data, generating
 * peering recommendations, creating reports, and detecting anomalies.
 * No data is sent to any cloud service.
 *
 * @see https://ollama.com/
 */

import { PeerCortexError } from "../types/common.js";

// ── Configuration ────────────────────────────────────────

interface OllamaClientConfig {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

/** Ollama generation request */
interface OllamaGenerateRequest {
  readonly model: string;
  readonly prompt: string;
  readonly system?: string;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly stream?: boolean;
}

/** Ollama generation response */
interface OllamaGenerateResponse {
  readonly model: string;
  readonly response: string;
  readonly done: boolean;
  readonly context?: ReadonlyArray<number>;
  readonly total_duration?: number;
  readonly load_duration?: number;
  readonly prompt_eval_count?: number;
  readonly prompt_eval_duration?: number;
  readonly eval_count?: number;
  readonly eval_duration?: number;
}

/** Ollama model info */
interface OllamaModelInfo {
  readonly name: string;
  readonly size: number;
  readonly digest: string;
  readonly details: {
    readonly format: string;
    readonly family: string;
    readonly parameter_size: string;
    readonly quantization_level: string;
  };
}

// ── Client ───────────────────────────────────────────────

/**
 * Ollama client for local AI analysis.
 *
 * All inference runs locally on your machine via Ollama.
 * No network data is sent to any external AI service.
 *
 * @example
 * ```typescript
 * const ai = createOllamaClient({ model: "llama3.1" });
 * const analysis = await ai.analyze("Analyze this BGP path: ...", "bgp_analysis");
 * ```
 */
export interface OllamaClient {
  /** Generate a response from the local LLM */
  generate(prompt: string, systemPrompt?: string): Promise<string>;

  /** Analyze network data with a specific analysis type */
  analyze(
    data: string,
    analysisType:
      | "bgp_analysis"
      | "peering_recommendation"
      | "anomaly_detection"
      | "rpki_assessment"
      | "network_comparison"
      | "report_generation"
  ): Promise<string>;

  /** Check if Ollama is running and the model is available */
  healthCheck(): Promise<boolean>;

  /** List available models */
  listModels(): Promise<ReadonlyArray<OllamaModelInfo>>;

  /** Get the currently configured model name */
  getModel(): string;
}

/**
 * Create a new Ollama client for local AI inference.
 *
 * @param config - Client configuration
 * @returns A configured Ollama client instance
 */
export function createOllamaClient(
  config: OllamaClientConfig = {}
): OllamaClient {
  const baseUrl = config.baseUrl ?? "http://localhost:11434";
  const model = config.model ?? "llama3.1";
  const timeoutMs = config.timeoutMs ?? 120000; // LLM inference can be slow

  /**
   * Make a request to the Ollama API.
   */
  async function ollamaRequest<T>(
    path: string,
    body?: unknown
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new PeerCortexError(
          `Ollama API error: ${response.status} ${response.statusText}`,
          "AI_UNAVAILABLE"
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof PeerCortexError) throw error;
      throw new PeerCortexError(
        `Ollama request failed: ${error instanceof Error ? error.message : "Unknown error"}. Is Ollama running at ${baseUrl}?`,
        "AI_UNAVAILABLE",
        undefined,
        error instanceof Error ? error : undefined
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async generate(prompt: string, systemPrompt?: string): Promise<string> {
      const request: OllamaGenerateRequest = {
        model,
        prompt,
        system: systemPrompt,
        stream: false,
        temperature: 0.3, // Low temperature for factual analysis
        top_p: 0.9,
      };

      const response = await ollamaRequest<OllamaGenerateResponse>(
        "/api/generate",
        request
      );

      return response.response;
    },

    async analyze(data: string, analysisType: string): Promise<string> {
      // Import prompts dynamically to avoid circular dependencies
      const { getSystemPrompt, formatAnalysisPrompt } = await import(
        "./prompts.js"
      );

      const systemPrompt = getSystemPrompt(analysisType);
      const prompt = formatAnalysisPrompt(analysisType, data);

      return this.generate(prompt, systemPrompt);
    },

    async healthCheck(): Promise<boolean> {
      try {
        const models = await this.listModels();
        return models.some((m) => m.name.startsWith(model));
      } catch {
        return false;
      }
    },

    async listModels(): Promise<ReadonlyArray<OllamaModelInfo>> {
      const response = await ollamaRequest<{
        models: ReadonlyArray<OllamaModelInfo>;
      }>("/api/tags");
      return response.models;
    },

    getModel(): string {
      return model;
    },
  };
}
