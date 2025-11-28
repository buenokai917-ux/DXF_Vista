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

  // For MINSERT (Multiple Insert)
  columnCount?: number; // Code 70
  rowCount?: number;    // Code 71
  columnSpacing?: number; // Code 44
  rowSpacing?: number;    // Code 45

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
  blockBasePoints: Record<string, Point>;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SearchResult {
  bounds: Bounds;
  rotation: number;
}

export interface ViewportRegion {
  bounds: Bounds;
  title: string;
  info: { prefix: string, index: number } | null;
}

export type LayerColors = { [key: string]: string };