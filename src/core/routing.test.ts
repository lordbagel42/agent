import { describe, expect, it } from "vitest";
import type { MessageEvent, Owner } from "./contracts.js";
import { routeEvent } from "./routing.js";

const owner: Owner = {
  id: "raygen",
  identities: [
    { channel: "slack", accountId: "T1", senderId: "U1" },
    { channel: "whatsapp", accountId: "P1", senderId: "15551234" },
  ],
};
const message: MessageEvent = {
  id: "Ev1",
  type: "message",
  messageId: "123.456",
  occurredAt: 1000,
  address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  senderId: "U1",
  direct: true,
  text: "hello",
};

describe("explicit identity linking", () => {
  it("preserves legacy owner routing while rejecting newly admitted ignored messages", () => {
    const ignored = { ...message, text: "## legacy pending turn" };
    expect(routeEvent(ignored, owner)).toBeUndefined();
    expect(routeEvent(ignored, owner, false)).toEqual({
      key: ["private", "raygen"],
      private: true,
    });
  });

  it("isolates explicitly addressed guests from owner/private and other guest queues", () => {
    const guest: MessageEvent = {
      ...message,
      senderId: "U2",
      direct: false,
      botMentioned: true,
      metadata: { channelType: "channel" },
      address: { ...message.address, conversationId: "C1" },
    };
    expect(routeEvent(guest, owner)).toEqual({
      key: ["guest", "slack", "T1", "C1", "", "U2"],
      private: false,
    });
    expect(
      routeEvent({ ...guest, botMentioned: false }, owner),
    ).toBeUndefined();
    expect(
      routeEvent({ ...guest, metadata: { channelType: "mpim" } }, owner),
    ).toBeUndefined();
    expect(
      routeEvent({ ...guest, text: "## <@BOT> ignore" }, owner),
    ).toBeUndefined();
    expect(
      routeEvent(
        { ...guest, address: { ...guest.address, accountId: "T2" } },
        owner,
      ),
    ).toBeUndefined();
    expect(routeEvent({ ...guest, senderId: "U3" }, owner)?.key).not.toEqual(
      routeEvent(guest, owner)?.key,
    );
    const dm = routeEvent(
      {
        ...guest,
        direct: true,
        botMentioned: false,
        metadata: { channelType: "im" },
        address: message.address,
      },
      owner,
    );
    expect(dm?.private).toBe(false);
    expect(dm?.key).not.toEqual(["private", "raygen"]);
  });

  it("shares linked private conversations without merging public threads", () => {
    expect(routeEvent(message, owner)).toEqual({
      key: ["private", "raygen"],
      private: true,
    });
    expect(
      routeEvent(
        {
          ...message,
          senderId: "15551234",
          address: {
            channel: "whatsapp",
            accountId: "P1",
            conversationId: "15551234",
          },
        },
        owner,
      ),
    ).toEqual({ key: ["private", "raygen"], private: true });
    const shared = {
      ...message,
      direct: false,
      address: {
        ...message.address,
        conversationId: "C1",
        threadId: "123.111",
      },
    };
    expect(routeEvent(shared, owner)).toEqual({
      key: ["slack", "T1", "C1", "123.111"],
      private: false,
    });
    expect(
      routeEvent(
        { ...shared, address: { ...shared.address, threadId: "123.222" } },
        owner,
      )?.key,
    ).not.toEqual(routeEvent(shared, owner)?.key);
  });

  it("does not treat a matching sender ID in another account as the owner", () => {
    expect(
      routeEvent(
        { ...message, address: { ...message.address, accountId: "T2" } },
        owner,
      ),
    ).toBeUndefined();
    expect(routeEvent({ ...message, senderId: "U2" }, owner)).toBeUndefined();
  });

  it("does not invent private/thread context for a Slack reaction", () => {
    expect(
      routeEvent(
        { ...message, type: "reaction", emoji: "heart", removed: false },
        owner,
      ),
    ).toEqual({ key: ["slack", "T1", "D1", ""], private: false });
  });

  it("routes receipts only for explicitly linked WhatsApp recipients", () => {
    expect(
      routeEvent(
        {
          id: "receipt1",
          type: "receipt",
          messageId: "wamid1",
          status: "read",
          occurredAt: 1000,
          address: {
            channel: "whatsapp",
            accountId: "P1",
            conversationId: "15551234",
          },
        },
        owner,
      ),
    ).toEqual({ key: ["private", "raygen"], private: true });
    expect(
      routeEvent(
        {
          id: "receipt2",
          type: "receipt",
          messageId: "wamid1",
          status: "read",
          occurredAt: 1000,
          address: {
            channel: "whatsapp",
            accountId: "P1",
            conversationId: "15559999",
          },
        },
        owner,
      ),
    ).toBeUndefined();
  });
});
