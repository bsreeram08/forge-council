type Listener = (data: unknown) => void;

export class EventBus {
  private listeners: Map<string, Set<Listener>> = new Map();

  subscribe(topic: string, callback: Listener): () => void {
    if (!this.listeners.has(topic)) {
      this.listeners.set(topic, new Set());
    }
    const topicListeners = this.listeners.get(topic)!;
    topicListeners.add(callback);

    return () => {
      topicListeners.delete(callback);
      if (topicListeners.size === 0) {
        this.listeners.delete(topic);
      }
    };
  }

  publish(topic: string, data: unknown): void {
    const topicListeners = this.listeners.get(topic);
    if (!topicListeners) return;
    for (const callback of topicListeners) {
      callback(data);
    }
  }
}

export const eventBus = new EventBus();
