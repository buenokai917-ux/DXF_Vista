export enum EntityType {
  LINE = 'LINE',
  LWPOLYLINE = 'LWPOLYLINE',
  CIRCLE = 'CIRCLE',
  ARC = 'ARC',
  TEXT = 'TEXT',
  DIMENSION = 'DIMENSION',
  INSERT = 'INSERT',
  UNKNOWN = 'UNKNOWN'
}

export interface Point {
  x: number;
  y: number;
}

export interface DxfEntity {
  type: EntityType;
  layer: string;
  // Specific properties based on type
  start?: Point;
  end?: Point;
  center?: Point;
  radius?: number;
  startAngle?: number; // In Degrees
  endAngle?: number;   // In Degrees
  vertices?: Point[];
  closed?: boolean;
  text?: string;
  // For Insert/Block
  blockName?: string;
  // For distinguishing MTEXT vs TEXT during parsing
  _originalType?: string; 
}

export interface DxfData {
  entities: DxfEntity[];
  layers: string[];
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type LayerColors = { [key: string]: string };