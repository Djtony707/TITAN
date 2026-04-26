import type React from 'react';

export interface Widget {
  id: string;
  title: string;
  code: string;
  compiledCode?: string;
  component?: React.FC<any>;
  error?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  createdAt: number;
}

export interface WidgetMessage {
  type: 'fetch' | 'setState' | 'getState' | 'log' | 'error';
  id: string;
  payload?: any;
}

export interface WidgetResponse {
  type: 'fetchResponse' | 'stateChange' | 'log' | 'error';
  id: string;
  payload?: any;
  error?: string;
}

export interface SpaceLayout {
  name: string;
  widgets: Widget[];
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  widgets?: Widget[];
}
