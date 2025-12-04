
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

export type LabelOrientation = number | null; // angle in degrees, null if unknown

export interface BeamLabelInfo {
  id: string;
  sourceLayer: string;
  orientation: LabelOrientation;
  textRaw: string;
  textInsert: Point | null;
  leaderStart: Point | null;
  leaderEnd: Point | null;
  parsed?: { code: string; span: string | null; width?: number; height?: number };
  hit?: {
    startHits?: number[];
    endHits?: number[];
    status?: 'start' | 'end' | 'both' | 'conflict' | 'none';
    chosen?: number;
  };
  notes?: string;
}

export type BeamShapeType = 'rect' | 'poly' | 'circle' | 'compound';

export interface BeamShapePart {
  shape: BeamShapeType;
  vertices?: Point[];
  center?: Point;
  radius?: number;
}

export interface BeamRectInfo {
  id: string;
  layer: string;
  shape: BeamShapeType;
  vertices: Point[];
  bounds: { startX: number; startY: number; endX: number; endY: number };
  center?: Point; // for circles/compounds
  radius?: number; // for circles
  parts?: BeamShapePart[]; // for compound shapes
  angle?: number; // orientation in degrees, optional
}

export interface BeamStep2GeoInfo extends BeamRectInfo {
  beamIndex: number;
}

export interface BeamStep3AttrInfo extends BeamRectInfo {
  beamIndex: number;
  code: string;
  span?: string | null;
  width?: number;
  height?: number;
  rawLabel: string;
}

export interface BeamStep4TopologyInfo extends BeamRectInfo {
  beamIndex: number;
  code: string;
  span?: string | null;
  width: number;
  height: number;
  rawLabel: string;
  length: number;
  volume: number;
}

export type IntersectionShape = 'C' | 'T' | 'L';

export interface BeamIntersectionInfo extends BeamRectInfo {
  junction: IntersectionShape; // L/T/C topology
  beamIndexes: number[]; // references beamStep2GeoInfo.beamIndex
}

export type LayerColors = { [key: string]: string };

export type AnalysisDomain = 'STRUCTURE' | 'LANDSCAPE' | 'ELECTRICAL';

export interface ProjectFile {
  id: string;
  name: string;
  data: DxfData;
  activeLayers: Set<string>;
  filledLayers: Set<string>;
  splitRegions: ViewportRegion[] | null;
  beamLabels?: BeamLabelInfo[];
  beamStep2GeoInfos?: BeamStep2GeoInfo[];
  beamStep2InterInfos?: BeamIntersectionInfo[];
  beamStep3AttrInfos?: BeamStep3AttrInfo[];
  beamStep4TopologyInfos?: BeamStep4TopologyInfo[];
}
