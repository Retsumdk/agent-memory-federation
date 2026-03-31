import * as dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import {
  FederationConfig,
  FederatedSearchResult,
  Memory,
  PrivacyLevel,
  SyncMessage,
  SyncPolicy,
  ConflictResolution,
} from './types';
import { MemoryStore } from './memory-store';

interface PeerConnection {
  agentId: string;
  agentName: string;
  address: string;
  lastSeen: number;
}

interface SearchResult {
  memory: Memory;
  agentId: string;
  agentName: string;
  similarity: number;
}

export class FederationClient extends EventEmitter {
  private config: FederationConfig;
  private localStore: MemoryStore;
  private peers: Map<string, PeerConnection> = new Map();
  private connected: boolean = false;
  private syncInterval: NodeJS.Timeout | null = null;
  private serverSocket: dgram.Socket | null = null;
  private messageId: number = 0;
  private pendingRequests: Map<string, (value: string) => void> = new Map();

  constructor(config: Partial<FederationConfig> & { agentId: string; agentName: string }) {
    super();
    this.config = {
      seedNodes: [],
      port: 0,
      syncPolicy: 'BIDIRECTIONAL',
      syncIntervalMs: 30000,
      maxMemorySize: 10000,
      vectorDimension: 1536,
      privacyLevel: 'balanced',
      allowedPeers: [],
      ...config,
    } as FederationConfig;
    this.localStore = new MemoryStore(this.config.maxMemorySize);
  }

  async connect(seedNode: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.serverSocket = dgram.createSocket('udp4');

        this.serverSocket.on('message', (msg, rinfo) => {
          this.handleIncomingMessage(msg, rinfo);
        });

        this.serverSocket.on('error', (err) => {
          this.emit('error', err);
        });

        this.serverSocket.bind(this.config.port || 0, () => {
          const addr = this.serverSocket?.address();
          if (addr) {
            this.config.port = addr.port;
          }

          this.joinNetwork(seedNode)
            .then(() => this.discoverPeers())
            .then(() => {
              this.startSyncLoop();
              this.connected = true;
              this.emit('connected');
              resolve();
            })
            .catch(reject);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    if (this.serverSocket) {
      this.serverSocket.close();
      this.serverSocket = null;
    }

    this.peers.clear();
    this.connected = false;
    this.emit('disconnected');
  }

  async federatedSearch(
    _query: string,
    embeddings: number[],
    options: {
      limit?: number;
      minSimilarity?: number;
      privacyLevel?: PrivacyLevel;
    } = {}
  ): Promise<FederatedSearchResult[]> {
    const { limit = 10, minSimilarity = 0.5, privacyLevel = 'balanced' } = options;
    const results: SearchResult[] = [];

    const localMemories = await this.localStore.getAll();
    for (const memory of localMemories) {
      if (privacyLevel === 'strict' && memory.metadata.privacy.level !== 'strict') continue;

      const similarity = this.cosineSimilarity(embeddings, memory.embedding);
      if (similarity >= minSimilarity) {
        results.push({
          memory,
          agentId: this.config.agentId,
          agentName: this.config.agentName,
          similarity,
        });
      }
    }

    const peerSearches = Array.from(this.peers.values()).map(async (peer) => {
      try {
        const peerResults = await this.queryPeer(peer, embeddings, {
          limit,
          minSimilarity,
          privacyLevel,
        });
        return peerResults;
      } catch {
        return [];
      }
    });

    const peerResults = await Promise.all(peerSearches);
    for (const batch of peerResults) {
      results.push(...batch);
    }

    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  async shareMemory(memoryId: string, targetAgentIds: string[]): Promise<void> {
    const memory = await this.localStore.retrieve(memoryId);
    if (!memory) throw new Error(`Memory ${memoryId} not found`);

    const message: SyncMessage = {
      type: 'UPDATE',
      agentId: this.config.agentId,
      memories: [memory],
      timestamp: Date.now(),
    };

    for (const agentId of targetAgentIds) {
      const peer = this.peers.get(agentId);
      if (peer) {
        await this.sendToPeer(peer, message);
      }
    }
  }

  subscribeToUpdates(callback: (memory: Memory, fromAgent: string) => void): void {
    this.on('memoryUpdate', callback);
  }

  async storeMemory(memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>): Promise<Memory> {
    return this.localStore.store(memory);
  }

  async retrieveMemory(id: string): Promise<Memory | null> {
    return this.localStore.retrieve(id);
  }

  getLocalStore(): MemoryStore {
    return this.localStore;
  }

  getConnectedPeers(): string[] {
    return Array.from(this.peers.keys());
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async joinNetwork(seedNode: string): Promise<void> {
    const [host, portStr] = seedNode.split(':');
    const port = parseInt(portStr) || 8080;

    const joinMessage: SyncMessage = {
      type: 'REQUEST',
      agentId: this.config.agentId,
      memories: [],
      timestamp: Date.now(),
    };

    await this.sendUDPMessage(JSON.stringify(joinMessage), host, port);
  }

  private async discoverPeers(): Promise<void> {
    for (const seed of this.config.seedNodes) {
      try {
        const [host, portStr] = seed.split(':');
        const port = parseInt(portStr) || 8080;

        const request: SyncMessage = {
          type: 'REQUEST',
          agentId: this.config.agentId,
          memories: [],
          timestamp: Date.now(),
        };

        const response = await this.sendRequest(
          JSON.stringify(request),
          host,
          port
        );
        const peers = JSON.parse(response);
        for (const peer of peers) {
          this.peers.set(peer.agentId, {
            ...peer,
            lastSeen: Date.now(),
          });
        }
      } catch {
        // Seed node unavailable, continue
      }
    }
  }

  private startSyncLoop(): void {
    if (this.syncInterval) return;

    this.syncInterval = setInterval(async () => {
      if (this.config.syncPolicy === 'MANUAL') return;

      for (const peer of this.peers.values()) {
        try {
          await this.syncWithPeer(peer);
        } catch {
          // Peer sync failed, will retry next interval
        }
      }
    }, this.config.syncIntervalMs);
  }

  private async syncWithPeer(peer: PeerConnection): Promise<ConflictResolution> {
    const localMemories = await this.localStore.getAll();
    const [host, portStr] = peer.address.split(':');
    const port = parseInt(portStr) || 8080;

    const message: SyncMessage = {
      type: 'REQUEST',
      agentId: this.config.agentId,
      memories: localMemories,
      timestamp: Date.now(),
    };

    const response = await this.sendRequest(JSON.stringify(message), host, port);
    const { memories: remoteMemories } = JSON.parse(response);

    return this.resolveConflicts(remoteMemories as Memory[]);
  }

  private resolveConflicts(remoteMemories: Memory[]): ConflictResolution {
    const localMemories = this.localStore.getAll();
    const conflicts: Memory[] = [];
    const resolved: Memory[] = [];

    for (const remote of remoteMemories) {
      const local = localMemories.find(m => m.id === remote.id);
      if (!local) {
        resolved.push(remote);
      } else if (local.updatedAt !== remote.updatedAt) {
        const merged = this.mergeMemories(local, remote);
        if (merged.conflict) {
          conflicts.push(local, remote);
        } else {
          resolved.push(merged.result);
          this.localStore.update(merged.result.id, merged.result);
        }
      }
    }

    return { strategy: 'MERGE', resolved, conflicts };
  }

  private mergeMemories(
    local: Memory,
    remote: Memory
  ): { result: Memory; conflict: boolean } {
    if (local.content === remote.content) {
      return { result: local, conflict: false };
    }

    const mergedContent = `${local.content}\n---\n${remote.content}`;
    const mergedEmbedding = local.embedding.map((v, i) => (v + remote.embedding[i]) / 2);
    const mergedTags = [...new Set([...local.metadata.tags, ...remote.metadata.tags])];

    return {
      result: {
        ...local,
        content: mergedContent,
        embedding: mergedEmbedding,
        metadata: {
          ...local.metadata,
          tags: mergedTags,
        },
        updatedAt: Date.now(),
      },
      conflict: true,
    };
  }

  private async queryPeer(
    peer: PeerConnection,
    embeddings: number[],
    options: { limit: number; minSimilarity: number; privacyLevel: PrivacyLevel }
  ): Promise<SearchResult[]> {
    const message = {
      type: 'SEARCH',
      agentId: this.config.agentId,
      embeddings,
      ...options,
      timestamp: Date.now(),
    };

    const [host, portStr] = peer.address.split(':');
    const port = parseInt(portStr) || 8080;

    try {
      const response = await this.sendRequest(JSON.stringify(message), host, port);
      const results = JSON.parse(response);
      return results.map((r: any) => ({
        ...r,
        agentId: peer.agentId,
        agentName: peer.agentName,
      }));
    } catch {
      return [];
    }
  }

  private async sendToPeer(peer: PeerConnection, message: SyncMessage): Promise<void> {
    if (!this.serverSocket) return;
    const [host, portStr] = peer.address.split(':');
    const port = parseInt(portStr) || 8080;
    await this.sendUDPMessage(JSON.stringify(message), host, port);
  }

  private sendUDPMessage(message: string, host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.serverSocket) return reject(new Error('No socket'));
      const buf = Buffer.from(message);
      this.serverSocket.send(buf, port, host, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private sendRequest(message: string, host: string, port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const requestId = `req_${++this.messageId}`;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Request timeout'));
      }, 5000);

      const handler = (msg: Buffer, _rinfo: dgram.RemoteInfo) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.requestId === requestId) {
            clearTimeout(timeout);
            this.serverSocket?.removeListener('message', handler);
            resolve(data.payload);
          }
        } catch {
          // Not our message
        }
      };

      this.pendingRequests.set(requestId, (payload) => resolve(payload));
      this.serverSocket?.on('message', handler);

      this.sendUDPMessage(JSON.stringify({ requestId, ...JSON.parse(message) }), host, port).catch(reject);
    });
  }

  private handleIncomingMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    try {
      const data = JSON.parse(msg.toString()) as SyncMessage & { requestId?: string };

      if (data.requestId && this.pendingRequests.has(data.requestId)) {
        const resolver = this.pendingRequests.get(data.requestId);
        this.pendingRequests.delete(data.requestId);
        resolver?.(JSON.stringify(data));
        return;
      }

      this.handleMessage(data, rinfo);
    } catch {
      // Invalid message, ignore
    }
  }

  private async handleMessage(message: SyncMessage, rinfo: dgram.RemoteInfo): Promise<void> {
    const peerAddress = `${rinfo.address}:${rinfo.port}`;

    switch (message.type) {
      case 'REQUEST': {
        this.peers.set(message.agentId, {
          agentId: message.agentId,
          agentName: message.agentId,
          address: peerAddress,
          lastSeen: Date.now(),
        });

        const response: SyncMessage = {
          type: 'RESPONSE',
          agentId: this.config.agentId,
          memories: await this.localStore.getAll(),
          timestamp: Date.now(),
        };
        await this.sendUDPMessage(JSON.stringify(response), rinfo.address, rinfo.port);
        break;
      }

      case 'UPDATE':
        for (const memory of message.memories) {
          const existing = await this.localStore.retrieve(memory.id);
          if (!existing || memory.updatedAt > existing.updatedAt) {
            await this.localStore.store(memory);
            this.emit('memoryUpdate', memory, message.agentId);
          }
        }
        break;

      case 'DELETE':
        for (const memory of message.memories) {
          await this.localStore.delete(memory.id);
        }
        break;
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    const dotProduct = a.reduce((sum, v, i) => sum + v * b[i], 0);
    const magnitudeA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
    const magnitudeB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
    if (magnitudeA === 0 || magnitudeB === 0) return 0;
    return dotProduct / (magnitudeA * magnitudeB);
  }
}