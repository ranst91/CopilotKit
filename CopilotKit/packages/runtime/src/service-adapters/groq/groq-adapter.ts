/**
 * CopilotRuntime Adapter for Groq.
 *
 * <RequestExample>
 * ```jsx CopilotRuntime Example
 * const copilotKit = new CopilotRuntime();
 * return copilotKit.response(req, new GroqAdapter());
 * ```
 * </RequestExample>
 *
 * You can easily set the model to use by passing it to the constructor.
 * ```jsx
 * const copilotKit = new CopilotRuntime();
 * return copilotKit.response(
 *   req,
 *   new GroqAdapter({ model: "gpt-4o" }),
 * );
 * ```
 *
 * To use your custom Groq instance, pass the `groq` property.
 * ```jsx
 * const groq = new Groq({
 *   apiKey: "your-api-key"
 * });
 *
 * const copilotKit = new CopilotRuntime();
 * return copilotKit.response(
 *   req,
 *   new GroqAdapter({ groq }),
 * );
 * ```
 *
 */
import { Groq } from "groq-sdk";
import {
  CopilotServiceAdapter,
  CopilotRuntimeChatCompletionRequest,
  CopilotRuntimeChatCompletionResponse,
} from "../service-adapter";
import {
  convertActionInputToOpenAITool,
  convertMessageToOpenAIMessage,
  limitMessagesToTokenCount,
} from "../openai/utils";
import { randomId } from "@copilotkit/shared";

const DEFAULT_MODEL = "llama3-groq-70b-8192-tool-use-preview";

export interface GroqAdapterParams {
  /**
   * An optional Groq instance to use.
   */
  groq?: Groq;

  /**
   * The model to use.
   */
  model?: string;
}

export class GroqAdapter implements CopilotServiceAdapter {
  private model: string = DEFAULT_MODEL;

  private _groq: Groq;
  public get groq(): Groq {
    return this._groq;
  }

  constructor(params?: GroqAdapterParams) {
    this._groq = params?.groq || new Groq({});
    if (params?.model) {
      this.model = params.model;
    }
  }

  async process(
    request: CopilotRuntimeChatCompletionRequest,
  ): Promise<CopilotRuntimeChatCompletionResponse> {
    const { threadId, model = this.model, messages, actions, eventSource } = request;
    const tools = actions.map(convertActionInputToOpenAITool);

    let openaiMessages = messages.map(convertMessageToOpenAIMessage);
    openaiMessages = limitMessagesToTokenCount(openaiMessages, tools, model);

    const stream = await this.groq.chat.completions.create({
      model: model,
      stream: true,
      messages: openaiMessages,
      ...(tools.length > 0 && { tools }),
    });

    eventSource.stream(async (eventStream$) => {
      let mode: "function" | "message" | null = null;
      for await (const chunk of stream) {
        const toolCall = chunk.choices[0].delta.tool_calls?.[0];
        const content = chunk.choices[0].delta.content;

        // When switching from message to function or vice versa,
        // send the respective end event.
        // If toolCall?.id is defined, it means a new tool call starts.
        if (mode === "message" && toolCall?.id) {
          mode = null;
          eventStream$.sendTextMessageEnd();
        } else if (mode === "function" && (toolCall === undefined || toolCall?.id)) {
          mode = null;
          eventStream$.sendActionExecutionEnd();
        }

        // If we send a new message type, send the appropriate start event.
        if (mode === null) {
          if (toolCall?.id) {
            mode = "function";
            eventStream$.sendActionExecutionStart(toolCall!.id, toolCall!.function!.name);
          } else if (content) {
            mode = "message";
            eventStream$.sendTextMessageStart(chunk.id);
          }
        }

        // send the content events
        if (mode === "message" && content) {
          eventStream$.sendTextMessageContent(content);
        } else if (mode === "function" && toolCall?.function?.arguments) {
          eventStream$.sendActionExecutionArgs(toolCall.function.arguments);
        }
      }

      // send the end events
      if (mode === "message") {
        eventStream$.sendTextMessageEnd();
      } else if (mode === "function") {
        eventStream$.sendActionExecutionEnd();
      }

      eventStream$.complete();
    });

    return {
      threadId: threadId || randomId(),
    };
  }
}
