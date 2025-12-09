

export enum EntityType {
  LINE = 'LINE',
  LWPOLYLINE = 'LWPOLYLINE',
  SPLINE = 'SPLINE',
  CIRCLE = 'CIRCLE',
  ARC = 'ARC',
  TEXT = 'TEXT',
  MTEXT = 'MTEXT',
  DIMENSION = 'DIMENSION',
  INSERT = 'INSERT',
  ATTRIB = 'ATTRIB',
  UNKNOWN = 'UNKNOWN'
}

export enum SemanticLayer {
  AXIS = 'AXIS',
  AXIS_OTHER = 'AXIS_OTHER',
  COLUMN = 'COLUMN',
  WALL = 'WALL',
  BEAM = 'BEAM',
  BEAM_LABEL = 'BEAM_LABEL',
  BEAM_IN_SITU_LABEL = 'BEAM_IN_SITU_LABEL',
  VIEWPORT_TITLE = 'VIEWPORT_TITLE'
}

export interface Point {
  x: number;
  y: number;
}

export interface PolylineVertex extends Point {
  bulge?: number; // DXF group code 42 for arc segments between vertices
}

export interface DxfEntity {
  handle?: string; // DXF entity handle (group code 5)
  type: EntityType;
  layer: string;
  // Specific properties based on type
  start?: Point;
  end?: Point;
  center?: Point;
  radius?: number;
  startAngle?: number; // In Degrees
  endAngle?: number;   // In Degrees
  vertices?: PolylineVertex[];
  closed?: boolean;
  text?: string;
  knots?: number[]; // For spline
  controlPoints?: Point[]; // Spline control points (group 10/20)
  fitPoints?: Point[]; // Spline fit points (group 11/21)
  weights?: number[]; // Spline weights (group 42 in SPLINE context)
  degree?: number; // Spline degree (group 71)

  // Explicit Visual Properties
  color?: number; // ACI Color (Group 62)
  lineType?: string; // Linetype Name (Group 6)
  lineTypeScale?: number;

  // For Dimensions
  measureStart?: Point; // Code 13, 23
  measureEnd?: Point;   // Code 14, 24

  // For Insert/Block
  blockName?: string;
  scale?: Point;
  rotation?: number;

  // For MINSERT
  columnCount?: number;
  rowCount?: number;
  columnSpacing?: number;
  rowSpacing?: number;

  // For attributes
  invisible?: boolean;
  hasAttributes?: boolean;

  // Metadata
  _originalType?: string;
  xAxis?: Point; // For MTEXT direction

  // Space flag: 0 or undefined = model space, 1 = paper space (group code 67)
  paperSpace?: number;
}

export interface DxfLayer {
  name: string;
  color: number; // ACI 1-255
  lineType: string;
}

export interface DxfData {
  entities: DxfEntity[];
  layers: string[];
  layerDictionary: Record<string, DxfLayer>;
  blocks: Record<string, DxfEntity[]>;
  blockBasePoints: Record<string, Point>;
}

export type LayerColors = Record<string, string>;

export interface AnalysisExportPayload {
  name: string;
  createdAt: string;
  layerConfig: Record<SemanticLayer, string[]>;
  splitRegions: ViewportRegion[] | null;
  mergedViewData?: MergedViewData;
  columns?: ColumnInfo[];
  walls?: WallInfo[];
  data: DxfData;
  activeLayers: string[];
  filledLayers: string[];
  step: 'raw' | 'split' | 'merge';
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SearchResult {
  bounds: Bounds;
  rotation?: number;
}

export interface ViewportRegion {
  bounds: Bounds;
  title: string;
  info: { prefix: string, index: number } | null;
}

export interface BeamStep2GeoInfo {
  id: string;
  layer: string;
  shape: 'rect' | 'poly';
  vertices: Point[];
  bounds: { startX: number, startY: number, endX: number, endY: number };
  center?: Point;
  radius?: number;
  angle?: number;
  beamIndex: number;
}

export type IntersectionShape = 'L' | 'T' | 'C'; // C = Cross

export interface BeamIntersectionInfo {
  id: string;
  layer: string;
  shape: 'rect';
  vertices: Point[];
  bounds: { startX: number, startY: number, endX: number, endY: number };
  center: Point;
  radius?: number;
  parts?: DxfEntity[];
  junction: IntersectionShape;
  angle?: number;
  beamIndexes: number[];
}

export interface BeamStep3AttrInfo {
  id: string;
  layer: string;
  shape: 'rect';
  vertices: Point[];
  bounds: { startX: number, startY: number, endX: number, endY: number };
  center?: Point;
  radius?: number;
  angle?: number;
  beamIndex: number;
  // Attributes
  code: string;
  span?: string | null;
  width: number;
  height: number;
  rawLabel: string;
}

export interface BeamStep4TopologyInfo extends BeamStep3AttrInfo {
  length: number;
  volume: number;
  parentBeamIndex: number;
}

export interface BeamLabelInfo {
  id: string;
  sourceLayer: string;
  orientation: number; // angle in degrees
  textRaw: string;
  textInsert: Point | null;
  leaderStart: Point | null;
  leaderEnd: Point | null;
  parsed?: {
    code: string;
    span: string | null;
    width?: number;
    height?: number;
  };
}

export interface ColumnInfo {
  id: string;
  layer: string;
  bounds: Bounds;
  width: number;
  height: number;
  center: Point;
}

export interface WallInfo {
  id: string;
  layer: string;
  bounds: Bounds;
  thickness: number;
  center: Point;
}

export interface ViewMergeMapping {
  sourceRegionIndex: number;
  targetRegionIndex: number;
  vector: Point;
  bounds: Bounds;
  title: string;
}

export interface MergedViewData {
  mappings: ViewMergeMapping[];
  beamLabels: BeamLabelInfo[];
  extras?: DxfEntity[]; // Leader lines, frames, etc.
}

export interface ProjectFile {
  id: string;
  name: string;
  data: DxfData;
  activeLayers: Set<string>;
  filledLayers: Set<string>;
  layerConfig: Record<SemanticLayer, string[]>;
  splitRegions: ViewportRegion[] | null;
  mergedViewData?: MergedViewData;
  columns?: ColumnInfo[];
  walls?: WallInfo[];
  beamLabels?: BeamLabelInfo[];
  beamStep2GeoInfos?: BeamStep2GeoInfo[];
  beamStep2InterInfos?: BeamIntersectionInfo[];
  beamStep3AttrInfos?: BeamStep3AttrInfo[];
  beamStep4TopologyInfos?: BeamStep4TopologyInfo[];
}

export type AnalysisDomain = 'STRUCTURE' | 'LANDSCAPE' | 'ELECTRICAL';
