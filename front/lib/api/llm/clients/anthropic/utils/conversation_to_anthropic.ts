import type {
  ImageBlockParam,
  MessageParam,
  TextBlockParam,
  ThinkingBlockParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { TOOL_NAME_SEPARATOR } from "@app/lib/actions/constants";
import type { AgentActionSpecification } from "@app/lib/actions/types/agent";
import {
  AGENT_SIDEKICK_CONTEXT_TOOL_NAME,
  AGENT_SIDEKICK_CONTEXT_TOOLS_METADATA,
} from "@app/lib/api/actions/servers/agent_sidekick_context/metadata";
import {
  CONFLUENCE_TOOL_NAME,
  CONFLUENCE_TOOLS_METADATA,
} from "@app/lib/api/actions/servers/confluence/metadata";
import {
  FILE_GENERATION_TOOL_NAME,
  FILE_GENERATION_TOOLS_METADATA,
} from "@app/lib/api/actions/servers/file_generation/metadata";
import {
  GMAIL_TOOL_NAME,
  GMAIL_TOOLS_METADATA,
} from "@app/lib/api/actions/servers/gmail/metadata";
import {
  GOOGLE_DRIVE_TOOL_NAME,
  GOOGLE_DRIVE_WRITE_TOOLS_METADATA,
} from "@app/lib/api/actions/servers/google_drive/metadata";
import {
  GOOGLE_SHEETS_TOOL_NAME,
  GOOGLE_SHEETS_TOOLS_METADATA,
} from "@app/lib/api/actions/servers/google_sheets/metadata";
import {
  INTERACTIVE_CONTENT_SERVER_NAME,
  INTERACTIVE_CONTENT_TOOLS_METADATA,
} from "@app/lib/api/actions/servers/interactive_content/metadata";
import {
  MICROSOFT_DRIVE_SERVER_NAME,
  MICROSOFT_DRIVE_TOOLS_METADATA,
} from "@app/lib/api/actions/servers/microsoft_drive/metadata";
import {
  MICROSOFT_EXCEL_SERVER_NAME,
  MICROSOFT_EXCEL_TOOLS_METADATA,
} from "@app/lib/api/actions/servers/microsoft_excel/metadata";
import {
  NOTION_TOOL_NAME,
  NOTION_TOOLS_METADATA,
} from "@app/lib/api/actions/servers/notion/metadata";
import {
  OUTLOOK_TOOL_NAME,
  OUTLOOK_TOOLS_METADATA,
} from "@app/lib/api/actions/servers/outlook/mail_metadata";
import {
  SANDBOX_TOOL_NAME,
  SANDBOX_TOOLS_METADATA,
} from "@app/lib/api/actions/servers/sandbox/metadata";
import {
  SLIDESHOW_SERVER_NAME,
  SLIDESHOW_TOOLS_METADATA,
} from "@app/lib/api/actions/servers/slideshow/metadata";
import { extractEncryptedContentFromMetadata } from "@app/lib/api/llm/utils";
import { parseToolArguments } from "@app/lib/api/llm/utils/tool_arguments";
import { concurrentExecutor } from "@app/lib/utils/async_utils";
import type {
  AgentFunctionCallContentType,
  AgentReasoningContentType,
  AgentTextContentType,
} from "@app/types/assistant/agent_message_content";
import type {
  AssistantContentMessageTypeModel,
  AssistantFunctionCallMessageTypeModel,
  Content,
  FunctionMessageTypeModel,
  ModelMessageTypeMultiActionsWithoutContentFragment,
  UserMessageTypeModel,
} from "@app/types/assistant/generation";
import { assertNever } from "@app/types/shared/utils/assert_never";
import { isString } from "@app/types/shared/utils/general";
import { trustedFetchImageBase64 } from "@app/types/shared/utils/image_utils";
import assert from "assert";
import compact from "lodash/compact";

const ACCEPTED_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;
type AcceptedMediaType = (typeof ACCEPTED_MEDIA_TYPES)[number];

function isAcceptedMediaType(
  mediaType: string
): mediaType is AcceptedMediaType {
  return ACCEPTED_MEDIA_TYPES.includes(mediaType as AcceptedMediaType);
}

async function userContentToParam(
  content: Content,
  { convertToBase64 }: { convertToBase64?: boolean } = {}
): Promise<TextBlockParam | ImageBlockParam> {
  switch (content.type) {
    case "text":
      return {
        type: "text",
        text: content.text,
      };
    case "image_url":
      if (!convertToBase64) {
        return {
          type: "image",
          source: {
            type: "url",
            url: content.image_url.url,
          },
        };
      }

      const { mediaType, data } = await trustedFetchImageBase64(
        content.image_url.url
      );

      assert(
        isAcceptedMediaType(mediaType),
        `Unsupported media type: ${mediaType}`
      );

      return {
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data,
        },
      };

    default:
      assertNever(content);
  }
}

function assistantContentToParam(
  content:
    | AgentTextContentType
    | AgentReasoningContentType
    | AgentFunctionCallContentType,
  omittedThinking: boolean
):
  | TextBlockParam
  | ImageBlockParam
  | ThinkingBlockParam
  | ToolUseBlockParam
  | undefined {
  switch (content.type) {
    case "text_content":
      return {
        type: "text",
        text: content.value,
      };
    case "reasoning":
      if (omittedThinking) {
        return;
      }
      assert(content.value.reasoning, "Reasoning content is missing reasoning");
      const signature = extractEncryptedContentFromMetadata(
        content.value.metadata
      );
      return {
        type: "thinking",
        thinking: content.value.reasoning,
        signature: signature,
      };
    case "function_call": {
      return {
        type: "tool_use",
        id: content.value.id,
        name: content.value.name,
        input: parseToolArguments(content.value.arguments, content.value.name),
      };
    }
  }
}

async function toolResultToParam(
  message: FunctionMessageTypeModel
): Promise<ToolResultBlockParam> {
  return {
    type: "tool_result",
    tool_use_id: message.function_call_id,
    content: isString(message.content)
      ? message.content
      : await concurrentExecutor(
          message.content,
          (c) => userContentToParam(c),
          { concurrency: 10 }
        ),
  };
}

async function functionMessage(
  message: FunctionMessageTypeModel
): Promise<MessageParam> {
  return {
    role: "user",
    content: [await toolResultToParam(message)],
  };
}

async function userMessage(
  message: UserMessageTypeModel,
  { isLast, convertToBase64 }: { isLast: boolean; convertToBase64: boolean }
): Promise<MessageParam> {
  const content = await concurrentExecutor(
    message.content,
    (c) => userContentToParam(c, { convertToBase64 }),
    { concurrency: 10 }
  );

  // Add cache_control to the last content block if this is the last message.
  if (isLast && content.length > 0) {
    content[content.length - 1].cache_control = { type: "ephemeral" };
  }

  return {
    role: "user",
    content,
  };
}

function assistantMessage(
  message:
    | AssistantFunctionCallMessageTypeModel
    | AssistantContentMessageTypeModel,
  omittedThinking: boolean
): MessageParam {
  const contents = compact(
    message.contents.map((content) =>
      assistantContentToParam(content, omittedThinking)
    )
  );

  return {
    role: "assistant",
    content: contents,
  };
}

export async function toMessage(
  message: ModelMessageTypeMultiActionsWithoutContentFragment,
  {
    isLast,
    omittedThinking,
    convertToBase64,
  }: {
    isLast: boolean;
    omittedThinking: boolean;
    convertToBase64?: boolean;
  } = {
    isLast: false,
    omittedThinking: false,
    convertToBase64: false,
  }
): Promise<MessageParam> {
  switch (message.role) {
    case "user":
      return userMessage(message, {
        isLast,
        convertToBase64: convertToBase64 ?? false,
      });
    case "function":
      return functionMessage(message);
    case "assistant":
      return assistantMessage(message, omittedThinking);
    default:
      assertNever(message);
  }
}

// Tool names sent to the model are prefixed with the server name
// (e.g. "file_generation__generate_file").
const TOOLS_WITH_POTENTIAL_LARGE_INPUTS = new Set<string>([
  // File generation and interactive content: generates full file content.
  `${FILE_GENERATION_TOOL_NAME}${TOOL_NAME_SEPARATOR}${FILE_GENERATION_TOOLS_METADATA["generate_file"].name}`,
  `${INTERACTIVE_CONTENT_SERVER_NAME}${TOOL_NAME_SEPARATOR}${INTERACTIVE_CONTENT_TOOLS_METADATA["create_interactive_content_file"].name}`,
  `${INTERACTIVE_CONTENT_SERVER_NAME}${TOOL_NAME_SEPARATOR}${INTERACTIVE_CONTENT_TOOLS_METADATA["edit_interactive_content_file"].name}`,
  // Sandbox: bash commands can include large inline scripts.
  `${SANDBOX_TOOL_NAME}${TOOL_NAME_SEPARATOR}${SANDBOX_TOOLS_METADATA["bash"].name}`,
  // Sidekick: rewrites the full agent prompt which can be very large.
  `${AGENT_SIDEKICK_CONTEXT_TOOL_NAME}${TOOL_NAME_SEPARATOR}${AGENT_SIDEKICK_CONTEXT_TOOLS_METADATA["suggest_prompt_edits"].name}`,
  // Confluence: page body can contain large storage/ADF content.
  `${CONFLUENCE_TOOL_NAME}${TOOL_NAME_SEPARATOR}${CONFLUENCE_TOOLS_METADATA["create_page"].name}`,
  `${CONFLUENCE_TOOL_NAME}${TOOL_NAME_SEPARATOR}${CONFLUENCE_TOOLS_METADATA["update_page"].name}`,
  // Gmail / Outlook: email drafts can contain large body content.
  `${GMAIL_TOOL_NAME}${TOOL_NAME_SEPARATOR}${GMAIL_TOOLS_METADATA["create_draft"].name}`,
  `${OUTLOOK_TOOL_NAME}${TOOL_NAME_SEPARATOR}${OUTLOOK_TOOLS_METADATA["create_draft"].name}`,
  // Notion: page content can contain large arrays of recursive block structures.
  `${NOTION_TOOL_NAME}${TOOL_NAME_SEPARATOR}${NOTION_TOOLS_METADATA["add_page_content"].name}`,
  // Google Drive: document/spreadsheet/presentation updates carry large request arrays.
  `${GOOGLE_DRIVE_TOOL_NAME}${TOOL_NAME_SEPARATOR}${GOOGLE_DRIVE_WRITE_TOOLS_METADATA["update_document"].name}`,
  `${GOOGLE_DRIVE_TOOL_NAME}${TOOL_NAME_SEPARATOR}${GOOGLE_DRIVE_WRITE_TOOLS_METADATA["append_to_spreadsheet"].name}`,
  `${GOOGLE_DRIVE_TOOL_NAME}${TOOL_NAME_SEPARATOR}${GOOGLE_DRIVE_WRITE_TOOLS_METADATA["update_spreadsheet"].name}`,
  `${GOOGLE_DRIVE_TOOL_NAME}${TOOL_NAME_SEPARATOR}${GOOGLE_DRIVE_WRITE_TOOLS_METADATA["update_presentation"].name}`,
  // Google Sheets: 2D arrays of cell data.
  `${GOOGLE_SHEETS_TOOL_NAME}${TOOL_NAME_SEPARATOR}${GOOGLE_SHEETS_TOOLS_METADATA["update_cells"].name}`,
  `${GOOGLE_SHEETS_TOOL_NAME}${TOOL_NAME_SEPARATOR}${GOOGLE_SHEETS_TOOLS_METADATA["append_data"].name}`,
  // Microsoft Drive: full Word document XML content.
  `${MICROSOFT_DRIVE_SERVER_NAME}${TOOL_NAME_SEPARATOR}${MICROSOFT_DRIVE_TOOLS_METADATA["update_word_document"].name}`,
  // Microsoft Excel: 2D array of cell data.
  `${MICROSOFT_EXCEL_SERVER_NAME}${TOOL_NAME_SEPARATOR}${MICROSOFT_EXCEL_TOOLS_METADATA["write_worksheet"].name}`,
  // Slideshow: up to 1MB of TSX/JSX content.
  `${SLIDESHOW_SERVER_NAME}${TOOL_NAME_SEPARATOR}${SLIDESHOW_TOOLS_METADATA["create_slideshow_file"].name}`,
  `${SLIDESHOW_SERVER_NAME}${TOOL_NAME_SEPARATOR}${SLIDESHOW_TOOLS_METADATA["edit_slideshow_file"].name}`,
]);

export function toTool(tool: AgentActionSpecification): Tool {
  return {
    name: tool.name,
    description: tool.description,
    // Eager input streaming allows the LLM to start streaming tool call arguments before
    // the full input is generated, which avoid hanging for long tool call arguments generation.
    // This is at the cost that JSON can be invalid so we only enabled for tools with
    // potentially large inputs.
    ...(TOOLS_WITH_POTENTIAL_LARGE_INPUTS.has(tool.name) && {
      eager_input_streaming: true,
    }),
    input_schema: { ...tool.inputSchema, type: "object" },
  };
}
