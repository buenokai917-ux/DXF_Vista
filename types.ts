export enum EntityType {
  LINE = 'LINE',
  LWPOLYLINE = 'LWPOLYLINE',
  CIRCLE = 'CIRCLE',
  ARC = 'ARC',
  TEXT = 'TEXT',
  DIMENSION = 'DIMENSION',
  INSERT = 'INSERT',
  ATTRIB = 'ATTRIB',
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
  
  // For Dimensions
  measureStart?: Point; // Code 13, 23
  measureEnd?: Point;   // Code 14, 24

  // For Insert/Block
  blockName?: string;
  scale?: Point; // X=41, Y=42, Z=43
  rotation?: number; // Code 50
  hasAttributes?: boolean; // Code 66

  // For Attrib
  invisible?: boolean; // Code 70 bit 1

  // For MTEXT direction
  xAxis?: Point; // Code 11, 21

  // For distinguishing MTEXT vs TEXT during parsing
  _originalType?: string; 
}

export interface DxfData {
  entities: DxfEntity[];
  layers: string[];
  blocks: Record<string, DxfEntity[]>;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type LayerColors = { [key: string]: string };