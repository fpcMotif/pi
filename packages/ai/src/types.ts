import type {
	Api,
	ImagesApi,
	ImagesModel,
	ImagesProvider,
	Model,
	ModelThinkingLevel,
	Provider,
	ThinkingBudgets,
	Usage,
} from "@earendil-works/pi-models";
import type { AssistantMessageDiagnostic } from "./utils/diagnostics.js";
import type { AssistantMessageEventStream } from "./utils/event-stream.js";

// Re-export registry-side types from @earendil-works/pi-models for back-compat.
// Consumers importing from "@earendil-works/pi-ai" continue to see the same
// type surface they had before the pi-models carve-out (ADR-0005, ADR-0006).
export type * from "@earendil-works/pi-models";

export type { AssistantMessageEventStream } from "./utils/event-stream.js";

// Base options all providers share
export type CacheRetention = "none" | "short" | "long";

export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

export interface StreamOptions {
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	/**
	 * Preferred transport for providers that support multiple transports.
	 * Providers that do not support this option ignore it.
	 */
	transport?: Transport;
	/**
	 * Prompt cache retention preference. Providers map this to their supported values.
	 * Default: "short".
	 */
	cacheRetention?: CacheRetention;
	/**
	 * Optional session identifier for providers that support session-based caching.
	 * Providers can use this to enable prompt caching, request routing, or other
	 * session-aware features. Ignored by providers that don't support it.
	 */
	sessionId?: string;
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * Return undefined to keep the payload unchanged.
	 */
	onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * Optional callback invoked after an HTTP response is received and before
	 * its body stream is consumed.
	 */
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	/**
	 * Optional custom HTTP headers to include in API requests.
	 * Merged with provider defaults; can override default headers.
	 * Not supported by all providers (e.g., AWS Bedrock uses SDK auth).
	 */
	headers?: Record<string, string>;
	/**
	 * HTTP request timeout in milliseconds for providers/SDKs that support it.
	 * For example, OpenAI and Anthropic SDK clients default to 10 minutes.
	 */
	timeoutMs?: number;
	/**
	 * Maximum retry attempts for providers/SDKs that support client-side retries.
	 * For example, OpenAI and Anthropic SDK clients default to 2.
	 */
	maxRetries?: number;
	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately
	 * with an error containing the requested delay, allowing higher-level retry logic
	 * to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 */
	maxRetryDelayMs?: number;
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 * For example, Anthropic uses `user_id` for abuse tracking and rate limiting.
	 */
	metadata?: Record<string, unknown>;
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

export interface ImagesOptions {
	signal?: AbortSignal;
	apiKey?: string;
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * Return undefined to keep the payload unchanged.
	 */
	onPayload?: (payload: unknown, model: ImagesModel<ImagesApi>) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * Optional callback invoked after an HTTP response is received.
	 */
	onResponse?: (response: ProviderResponse, model: ImagesModel<ImagesApi>) => void | Promise<void>;
	/**
	 * Optional custom HTTP headers to include in API requests.
	 * Merged with provider defaults; can override default headers.
	 */
	headers?: Record<string, string>;
	/**
	 * HTTP request timeout in milliseconds for providers/SDKs that support it.
	 */
	timeoutMs?: number;
	/**
	 * Maximum retry attempts for providers/SDKs that support client-side retries.
	 */
	maxRetries?: number;
	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately
	 * with an error containing the requested delay, allowing higher-level retry logic
	 * to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 */
	maxRetryDelayMs?: number;
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 */
	metadata?: Record<string, unknown>;
}

export type ProviderImagesOptions = ImagesOptions & Record<string, unknown>;

// Unified options with reasoning passed to streamSimple() and completeSimple()
export interface SimpleStreamOptions extends StreamOptions {
	reasoning?: ModelThinkingLevel;
	/** Custom token budgets for thinking levels (token-based providers only) */
	thinkingBudgets?: ThinkingBudgets;
}

// Generic StreamFunction with typed options.
//
// Contract:
// - Must return an AssistantMessageEventStream.
// - Once invoked, request/model/runtime failures should be encoded in the
//   returned stream, not thrown.
// - Error termination must produce an AssistantMessage with stopReason
//   "error" or "aborted" and errorMessage, emitted via the stream protocol.
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: Context,
	options?: TOptions,
) => AssistantMessageEventStream;

export type ImagesFunction<TApi extends ImagesApi = ImagesApi, TOptions extends ImagesOptions = ImagesOptions> = (
	model: ImagesModel<TApi>,
	context: ImagesContext,
	options?: TOptions,
) => Promise<AssistantImages>;

export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string; // e.g., for OpenAI responses, message metadata (legacy id string or TextSignatureV1 JSON)
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // e.g., for OpenAI responses, the reasoning item ID
	/** When true, the thinking content was redacted by safety filters. The opaque
	 *  encrypted payload is stored in `thinkingSignature` so it can be passed back
	 *  to the API for multi-turn continuity. */
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string; // base64 encoded image data
	mimeType: string; // e.g., "image/jpeg", "image/png"
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	thoughtSignature?: string; // Google-specific: opaque signature for reusing thought context
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number; // Unix timestamp in milliseconds
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: Provider;
	model: string;
	responseModel?: string; // Concrete `chunk.model` when different from the requested `model` (e.g. OpenRouter `auto` -> `anthropic/...`)
	responseId?: string; // Provider-specific response/message identifier when the upstream API exposes one
	diagnostics?: AssistantMessageDiagnostic[]; // Redacted provider/runtime diagnostics for failures and recoveries.
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number; // Unix timestamp in milliseconds
}

export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[]; // Supports text and images
	details?: TDetails;
	isError: boolean;
	timestamp: number; // Unix timestamp in milliseconds
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type ImagesInputContent = TextContent | ImageContent;
export type ImagesOutputContent = TextContent | ImageContent;

export interface ImagesContext {
	input: ImagesInputContent[];
}

export type ImagesStopReason = "stop" | "error" | "aborted";

export interface AssistantImages {
	api: ImagesApi;
	provider: ImagesProvider;
	model: string;
	output: ImagesOutputContent[];
	responseId?: string;
	usage?: Usage;
	stopReason: ImagesStopReason;
	errorMessage?: string;
	timestamp: number; // Unix timestamp in milliseconds
}

import type { TSchema } from "typebox";

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
}

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

/**
 * Event protocol for AssistantMessageEventStream.
 *
 * Streams should emit `start` before partial updates, then terminate with either:
 * - `done` carrying the final successful AssistantMessage, or
 * - `error` carrying the final AssistantMessage with stopReason "error" or "aborted"
 *   and errorMessage.
 */
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };
