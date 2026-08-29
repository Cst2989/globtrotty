import Anthropic from '@anthropic-ai/sdk'
import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'

/**
 * Everything that talks to a model goes through this one shape, so tests can
 * hand in a recorded client and production hands in the SDK.
 */
export type ModelClient = {
  create(params: MessageCreateParamsNonStreaming): Promise<Message>
}

/**
 * The SDK reads ANTHROPIC_API_KEY itself. A key created under a Console user
 * (an identity-linked key) is refused unless the request names a workspace,
 * so we pass that header when ANTHROPIC_WORKSPACE_ID is set.
 */
export function liveClient(): ModelClient {
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID
  const anthropic = new Anthropic(
    workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {},
  )
  return { create: (params) => anthropic.messages.create(params) }
}

/** The reply text, with every text block joined; tool blocks are not text. */
export function textOf(message: Message): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}
