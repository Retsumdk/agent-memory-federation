import { Memory, MemoryMetadata, PrivacyLevel } from './types';

export class MemoryStore {
  private memories: Map<string, Memory> = new Map();
  private maxSize: number;

  constructor(maxSize: number = 10000) {
    this.maxSize = maxSize;
  }

  async store(memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>): Promise<Memory> {
    if (this.memories.size >= this.maxSize) {
      await this.evictLeastUseful();
    }

    const now = Date.now();
    const id = this.generateId();
    const fullMemory: Memory = {
      ...memory,
      id,
      createdAt: now,
      updatedAt: now,
    };

    this.memories.set(id, fullMemory);
    return fullMemory;
  }

  async retrieve(id: string): Promise<Memory | null> {
    return this.memories.get(id) || null;
  }

  async update(id: string, updates: Partial<Memory>): Promise<Memory | null> {
    const existing = this.memories.get(id);
    if (!existing) return null;

    const updated: Memory = {
      ...existing,
      ...updates,
      id,
      updatedAt: Date.now(),
    };
    this.memories.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.memories.delete(id);
  }

  async search(query: string, embeddings: number[], options: {
    limit?: number;
    minSimilarity?: number;
    tags?: string[];
    privacyLevel?: PrivacyLevel;
  } = {}): Promise<Memory[]> {
    const { limit = 10, minSimilarity = 0.5, tags, privacyLevel = 'balanced' } = options;
    const results: Array<{ memory: Memory; similarity: number }> = [];

    for (const memory of this.memories.values()) {
      if (tags && tags.length > 0) {
        if (!tags.some(t => memory.metadata.tags.includes(t))) continue;
      }

      if (privacyLevel === 'strict' && memory.metadata.privacy.level !== 'strict') continue;

      const similarity = this.cosineSimilarity(embeddings, memory.embedding);
      if (similarity >= minSimilarity) {
        results.push({ memory, similarity });
      }
    }

    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
      .map(r => r.memory);
  }

  async getAll(): Promise<Memory[]> {
    return Array.from(this.memories.values());
  }

  async export(): Promise<string> {
    return JSON.stringify(Array.from(this.memories.values()), null, 2);
  }

  async import(data: string): Promise<number> {
    const memories = JSON.parse(data) as Memory[];
    let count = 0;
    for (const memory of memories) {
      if (!this.memories.has(memory.id)) {
        this.memories.set(memory.id, memory);
        count++;
      }
    }
    return count;
  }

  getSize(): number {
    return this.memories.size;
  }

  private generateId(): string {
    return `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    const dotProduct = a.reduce((sum, v, i) => sum + v * b[i], 0);
    const magnitudeA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
    const magnitudeB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
    if (magnitudeA === 0 || magnitudeB === 0) return 0;
    return dotProduct / (magnitudeA * magnitudeB);
  }

  private async evictLeastUseful(): Promise<void> {
    let oldestUseful: Memory | null = null;
    let oldestTime = Infinity;

    for (const memory of this.memories.values()) {
      if (memory.metadata.confidence > 0.7) continue;
      if (memory.updatedAt < oldestTime) {
        oldestTime = memory.updatedAt;
        oldestUseful = memory;
      }
    }

    if (oldestUseful) {
      this.memories.delete(oldestUseful.id);
    }
  }
}