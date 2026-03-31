export type SyncPolicy = 'BIDIRECTIONAL' | 'ONE_WAY' | 'MANUAL';
export type PrivacyLevel = 'strict' | 'balanced' | 'open';

export interface Memory {
  id: string;
  content: string;
  embedding: number[];
  metadata: MemoryMetadata;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryMetadata {
  source: string;
  tags: string[];
  confidence: number;
  privacy: {
    level: PrivacyLevel;
    masked: boolean;
  };
}

export interface FederationConfig {
  agentId: string;
  agentName: string;
  seedNodes: string[];
  port: number;
  syncPolicy: SyncPolicy;
  syncIntervalMs: number;
  maxMemorySize: number;
  vectorDimension: number;
  privacyLevel: PrivacyLevel;
  allowedPeers: string[];
}

export interface FederatedSearchResult {
  memory: Memory;
  agentId: string;
  agentName: string;
  similarity: number;
}

export interface SyncMessage {
  type: 'REQUEST' | 'RESPONSE' | 'UPDATE' | 'DELETE';
  agentId: string;
  memories: Memory[];
  timestamp: number;
}

export interface ConflictResolution {
  strategy: 'LATEST' | 'MERGE' | 'MANUAL';
  resolved: Memory[];
  conflicts: Memory[];
}