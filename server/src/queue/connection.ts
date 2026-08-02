import { Redis } from "ioredis";
import { env } from "../config/env.js";

// BullMQ requires this exact option; Valkey speaks the Redis protocol so this connects fine.
export const queueConnection = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: null });
