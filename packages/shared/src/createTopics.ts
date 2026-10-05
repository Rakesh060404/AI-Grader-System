import { Kafka } from "kafkajs";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { TOPICS } from "./kafka.js";

const config = loadConfig();
const kafka = new Kafka({
  clientId: "ai-grader-topic-admin",
  brokers: config.KAFKA_BROKERS
});
const admin = kafka.admin();

try {
  await admin.connect();
  await admin.createTopics({
    waitForLeaders: true,
    topics: [{
      topic: TOPICS.submissionCompleted,
      numPartitions: 1,
      replicationFactor: 1
    }]
  });
  logger.info("Kafka topic is ready", { topic: TOPICS.submissionCompleted });
} catch (error) {
  logger.error("Failed to create Kafka topics", {
    error: error instanceof Error ? error.message : "Unknown error"
  });
  process.exitCode = 1;
} finally {
  await admin.disconnect();
}
