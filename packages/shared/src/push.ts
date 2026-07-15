import { z } from "zod";

export const PushSubscriptionSchema = z.object({
  endpoint: z.string().min(1),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

export type PushSubscriptionInfo = z.infer<typeof PushSubscriptionSchema>;
