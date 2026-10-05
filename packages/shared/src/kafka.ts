import { Kafka, Partitioners, type Consumer, type Producer } from "kafkajs";

export const TOPICS = {
  submissionCompleted: "submission.completed"
} as const;

export function createKafkaProducer(brokers: string[], clientId = "ai-grader"): Producer {
  const kafka = new Kafka({
    clientId,
    brokers,
    retry: {
      initialRetryTime: 250,
      retries: 5
    }
  });

  return kafka.producer({
    allowAutoTopicCreation: false,
    createPartitioner: Partitioners.DefaultPartitioner
  });
}

export function createKafkaConsumer(
  brokers: string[],
  groupId: string,
  clientId = "ai-grader"
): Consumer {
  const kafka = new Kafka({
    clientId,
    brokers,
    retry: {
      initialRetryTime: 250,
      retries: 5
    }
  });

  return kafka.consumer({ groupId });
}
