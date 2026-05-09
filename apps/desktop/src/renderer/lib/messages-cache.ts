import type { InfiniteData } from '@tanstack/react-query';
import type { MessageRecord } from '@discord2/shared';

export type MessagesInfiniteData = InfiniteData<MessageRecord[], unknown>;

export function flattenMessagePages(data: MessagesInfiniteData | undefined): MessageRecord[] {
  if (!data) return [];
  const result: MessageRecord[] = [];
  for (let i = data.pages.length - 1; i >= 0; i--) {
    const page = data.pages[i];
    if (page) result.push(...page);
  }
  return result;
}

export function appendMessage(
  current: MessagesInfiniteData | undefined,
  message: MessageRecord,
): MessagesInfiniteData {
  if (!current) {
    return { pages: [[message]], pageParams: [undefined] };
  }
  const [first = [], ...rest] = current.pages;
  if (first.some((m) => m.id === message.id)) return current;
  return { ...current, pages: [[...first, message], ...rest] };
}

export function removeMessage(
  current: MessagesInfiniteData | undefined,
  messageId: string,
): MessagesInfiniteData | undefined {
  if (!current) return current;
  return {
    ...current,
    pages: current.pages.map((page) => page.filter((m) => m.id !== messageId)),
  };
}

export function replaceMessage(
  current: MessagesInfiniteData | undefined,
  message: MessageRecord,
): MessagesInfiniteData | undefined {
  if (!current) return current;
  return {
    ...current,
    pages: current.pages.map((page) =>
      page.map((m) => (m.id === message.id ? message : m)),
    ),
  };
}

export function mapMessages(
  current: MessagesInfiniteData | undefined,
  mapper: (message: MessageRecord) => MessageRecord,
): MessagesInfiniteData | undefined {
  if (!current) return current;
  return {
    ...current,
    pages: current.pages.map((page) => page.map(mapper)),
  };
}

export function replacePending(
  current: MessagesInfiniteData | undefined,
  message: MessageRecord,
): MessagesInfiniteData | undefined {
  if (!current) {
    return { pages: [[message]], pageParams: [undefined] };
  }
  const cleaned: MessagesInfiniteData = {
    ...current,
    pages: current.pages.map((page) => page.filter((m) => !m.id.startsWith('pending-'))),
  };
  return appendMessage(cleaned, message);
}
