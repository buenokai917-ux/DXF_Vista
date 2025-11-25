import { DxfData, DxfEntity, EntityType, Point } from '../types';

/**
 * Helper to decode DXF string format.
 * Handles \U+XXXX unicode, MTEXT formatting {\W...;}, and standard symbols like %%d.
 */
const decodeDxfString = (str: string): string => {
  let s = str;

  // 1. Unicode Decoding
  s = s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  s = s.replace(/\\M\+1([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  // 2. MTEXT Formatting Stripping
  // Replace New Paragraph \P with newline
  s = s.replace(/\\P/gi, '\n');
  
  // Strip formatting properties with arguments ending in ; (e.g. \W0.8; \Ftxt; \H10;)
  // Matches Backslash + [ACFHQTW] + any chars + ;
  s = s.replace(/\\[ACFHQTW][^;]*;/gi, '');
  
  // Strip Stacking \S...; (e.g. \S1/2;) -> Keep the content "1/2"
  s = s.replace(/\\S([^;]*);/gi, '$1');
  
  // Strip simple switches (e.g. \L for underline, \O for overline)
  s = s.replace(/\\[LOKlok]/g, '');

  // Strip grouping braces {} (Common in MTEXT like {\W...;Text})
  s = s.replace(/[{}]/g, '');

  // 3. Standard Symbols
  s = s.replace(/%%c/gi, 'ø');
  s = s.replace(/%%d/gi, '°');
  s = s.replace(/%%p/gi, '±');
  s = s.replace(/%%u/gi, ''); // Underline toggle (not supported in simple canvas)
  s = s.replace(/%%o/gi, ''); // Overline toggle

  return s.trim();
};

/**
 * A streamlined DXF parser.
 * Supports TABLES (Layers), BLOCKS (Definitions), and ENTITIES (Geometry).
 */
export const parseDxf = (dxfContent: string): DxfData => {
  const lines = dxfContent.split(/\r\n|\r|\n/);
  const entities: DxfEntity[] = [];
  const blocks: Record<string, DxfEntity[]> = {};
  const layers = new Set<string>();

  let section = 'NONE'; // NONE | TABLES | BLOCKS | ENTITIES
  let tableType = 'NONE'; // Inside TABLES: LAYER, etc.
  
  // For Block Parsing
  let activeBlockName: string | null = null;
  
  // For Entity Parsing
  let currentEntity: Partial<DxfEntity> | null = null;
  let inPolyline = false;
  
  let i = 0;

  while (i < lines.length) {
    const codeStr = lines[i].trim();
    const value = lines[i + 1]?.trim();
    i += 2;

    if (!codeStr || value === undefined) continue;
    const code = parseInt(codeStr, 10);
    if (isNaN(code)) continue;

    // Handle Section Start
    if (code === 0 && value === 'SECTION') {
      const nextCode = parseInt(lines[i]?.trim(), 10);
      const nextValue = lines[i + 1]?.trim();
      if (nextCode === 2) {
        section = nextValue;
        i += 2;
      }
      continue;
    }

    // Handle Section End
    if (code === 0 && value === 'ENDSEC') {
      section = 'NONE';
      tableType = 'NONE';
      continue;
    }

    // --- TABLES SECTION (Get all Layer names) ---
    if (section === 'TABLES') {
      if (code === 0 && value === 'TABLE') {
        continue;
      }
      
      if (code === 2 && value === 'LAYER') {
        tableType = 'LAYER';
      } else if (code === 0 && value === 'ENDTAB') {
        tableType = 'NONE';
      }

      if (tableType === 'LAYER') {
        if (code === 2) {
            layers.add(decodeDxfString(value));
        }
      }
    }

    // --- BLOCKS SECTION ---
    if (section === 'BLOCKS') {
       if (code === 0) {
          if (value === 'BLOCK') {
             // Start of a block definition
             activeBlockName = null; // Will be set by code 2
          } else if (value === 'ENDBLK') {
             // End of block
             if (currentEntity && activeBlockName && blocks[activeBlockName]) {
                 // Push the last entity inside the block
                 finalizeEntity(currentEntity, blocks[activeBlockName], layers);
                 currentEntity = null;
             }
             activeBlockName = null;
          } else {
             // Entity inside a block
             if (activeBlockName) {
                 handleEntityStart(value, 
                   (ent) => {
                       if (!blocks[activeBlockName!]) blocks[activeBlockName!] = [];
                       finalizeEntity(ent, blocks[activeBlockName!], layers);
                   }, 
                   () => currentEntity, 
                   (e) => currentEntity = e,
                   () => inPolyline,
                   (b) => inPolyline = b
                 );
             }
          }
       } else if (activeBlockName) {
           // Properties of entity inside block
           if (currentEntity) {
               if (inPolyline && currentEntity._originalType === 'POLYLINE') {
                   parsePolylineProperty(code, value, currentEntity);
               } else {
                   parseProperty(code, value, currentEntity);
               }
           }
       } else {
           // Properties of the BLOCK definition itself (we just need the name)
           if (code === 2) {
               activeBlockName = value;
               blocks[activeBlockName] = [];
           }
       }
    }

    // --- ENTITIES SECTION ---
    if (section === 'ENTITIES') {
      if (code === 0) {
        handleEntityStart(value, 
            (ent) => finalizeEntity(ent, entities, layers),
            () => currentEntity, 
            (e) => currentEntity = e,
            () => inPolyline,
            (b) => inPolyline = b
        );
      } else if (currentEntity) {
        // Parse Properties
        if (inPolyline && currentEntity._originalType === 'POLYLINE') {
            parsePolylineProperty(code, value, currentEntity);
        } else {
            parseProperty(code, value, currentEntity);
        }
      }
    }
  }

  // Push last entity of ENTITIES section
  if (currentEntity && section === 'ENTITIES') {
    finalizeEntity(currentEntity, entities, layers);
  }

  return {
    entities,
    layers: Array.from(layers).sort(),
    blocks
  };
};

/**
 * Centralized logic to start a new entity, reused for ENTITIES and BLOCKS sections.
 */
const handleEntityStart = (
    typeStr: string,
    onFinalize: (e: Partial<DxfEntity>) => void,
    getCurrent: () => Partial<DxfEntity> | null,
    setCurrent: (e: Partial<DxfEntity> | null) => void,
    getInPolyline: () => boolean,
    setInPolyline: (b: boolean) => void
) => {
    const current = getCurrent();
    const inPoly = getInPolyline();

    // Special handling for POLYLINE sequence
    if (typeStr === 'POLYLINE') {
        // If we were already in a polyline (nested? shouldn't happen), finalize it
        if (current && !inPoly) {
            onFinalize(current);
        }
        setInPolyline(true);
        setCurrent({
            type: EntityType.LWPOLYLINE,
            layer: '0',
            vertices: [],
            _originalType: 'POLYLINE'
        });
        return;
    } 
    
    if (typeStr === 'VERTEX') {
        // Just continue adding properties to the parent POLYLINE
        return;
    }
    
    if (typeStr === 'SEQEND') {
        if (inPoly && current) {
            onFinalize(current);
            setCurrent(null);
            setInPolyline(false);
        }
        return;
    }

    // Normal Entity Start
    if (inPoly) {
        // Implicit end of polyline if we hit a non-vertex/seqend
        if (current) onFinalize(current);
        setInPolyline(false);
    } else if (current) {
        onFinalize(current);
    }

    setCurrent({
        type: mapType(typeStr),
        layer: '0',
        vertices: [],
        _originalType: typeStr
    });
};

const mapType = (typeStr: string): EntityType => {
  switch (typeStr) {
    case 'LINE': return EntityType.LINE;
    case 'LWPOLYLINE': return EntityType.LWPOLYLINE;
    case 'CIRCLE': return EntityType.CIRCLE;
    case 'ARC': return EntityType.ARC;
    case 'TEXT': return EntityType.TEXT;
    case 'MTEXT': return EntityType.TEXT;
    case 'DIMENSION': return EntityType.DIMENSION;
    case 'INSERT': return EntityType.INSERT;
    default: return EntityType.UNKNOWN;
  }
};

const parsePolylineProperty = (code: number, value: string, entity: Partial<DxfEntity>) => {
    const valNum = parseFloat(value);
    
    if (code === 8) { // Layer
        entity.layer = decodeDxfString(value);
    } else if (code === 70) { // Closed flag
         if ((parseInt(value) & 1) === 1) entity.closed = true;
    } else if (code === 10) {
        if (!entity.vertices) entity.vertices = [];
        entity.vertices.push({ x: valNum, y: 0 });
    } else if (code === 20) {
        if (entity.vertices && entity.vertices.length > 0) {
            entity.vertices[entity.vertices.length - 1].y = valNum;
        }
    }
};

const parseProperty = (code: number, value: string, entity: Partial<DxfEntity>) => {
  const valNum = parseFloat(value);
  
  switch (code) {
    case 8: // Layer Name
      entity.layer = decodeDxfString(value);
      break;
    
    // Coordinates
    case 10: // Start X / Center X / Insertion X
      if (!entity.start) entity.start = { x: 0, y: 0 };
      if (!entity.center) entity.center = { x: 0, y: 0 };
      
      if (entity.type === EntityType.LWPOLYLINE) {
        entity.vertices?.push({ x: valNum, y: 0 });
      } else {
        entity.start.x = valNum;
        entity.center.x = valNum; 
      }
      break;
    case 20: // Start Y / Center Y / Insertion Y
      if (entity.type === EntityType.LWPOLYLINE) {
        const lastV = entity.vertices ? entity.vertices[entity.vertices.length - 1] : null;
        if (lastV) lastV.y = valNum;
      } else {
        if (entity.start) entity.start.y = valNum;
        if (entity.center) entity.center.y = valNum;
      }
      break;
      
    case 11: // End X (TEXT) or Direction X (MTEXT)
       if (entity._originalType === 'MTEXT') {
           if (!entity.xAxis) entity.xAxis = { x: 0, y: 0 };
           entity.xAxis.x = valNum;
       } else {
           if (!entity.end) entity.end = { x: 0, y: 0 };
           entity.end.x = valNum;
       }
       break;
    case 21: // End Y (TEXT) or Direction Y (MTEXT)
       if (entity._originalType === 'MTEXT') {
           if (!entity.xAxis) entity.xAxis = { x: 0, y: 0 };
           entity.xAxis.y = valNum;
       } else {
           if (!entity.end) entity.end = { x: 0, y: 0 };
           entity.end.y = valNum;
       }
       break;

    case 13: // Measure Start X (Dimension)
      if (!entity.measureStart) entity.measureStart = { x: 0, y: 0 };
      entity.measureStart.x = valNum;
      break;
    case 23: // Measure Start Y
      if (!entity.measureStart) entity.measureStart = { x: 0, y: 0 };
      entity.measureStart.y = valNum;
      break;

    case 14: // Measure End X (Dimension)
      if (!entity.measureEnd) entity.measureEnd = { x: 0, y: 0 };
      entity.measureEnd.x = valNum;
      break;
    case 24: // Measure End Y
      if (!entity.measureEnd) entity.measureEnd = { x: 0, y: 0 };
      entity.measureEnd.y = valNum;
      break;

    case 40: // Radius or Text Height
      entity.radius = valNum;
      break;
    
    case 41: // Scale X (Insert)
      if (!entity.scale) {
          entity.scale = { x: valNum, y: valNum };
      } else {
          entity.scale.x = valNum;
      }
      break;
    case 42: // Scale Y (Insert)
      if (!entity.scale) entity.scale = { x: 1, y: 1 };
      entity.scale.y = valNum;
      break;

    case 50: // Angle / Rotation
      if (entity._originalType === 'MTEXT') {
          // MTEXT angle is in radians
          entity.startAngle = valNum * (180 / Math.PI);
      } else if (entity.type === EntityType.INSERT) {
          entity.rotation = valNum;
      } else {
          // TEXT angle is in degrees
          entity.startAngle = valNum; 
      }
      break;
      
    case 51: // End Angle (Arc)
      entity.endAngle = valNum; 
      break;
      
    case 70: // Flags
       if (entity.type === EntityType.LWPOLYLINE) {
         if ((parseInt(value) & 1) === 1) entity.closed = true;
       }
       break;
    
    case 1: // Text content
      entity.text = decodeDxfString(value);
      break;
      
    case 2: // Block Name for INSERT
      if (entity.type === EntityType.INSERT) {
        entity.blockName = value;
      }
      break;
  }
};

const finalizeEntity = (raw: Partial<DxfEntity>, list: DxfEntity[], layers: Set<string>) => {
  if (raw.type === EntityType.UNKNOWN) return;
  
  // Fix MTEXT rotation based on direction vector if present
  if (raw._originalType === 'MTEXT' && raw.xAxis) {
      // Calculate angle from vector (atan2 returns radians)
      // We convert to degrees for consistency with startAngle usage
      raw.startAngle = Math.atan2(raw.xAxis.y, raw.xAxis.x) * (180 / Math.PI);
  }

  if (raw.layer) layers.add(raw.layer);
  list.push(raw as DxfEntity);
};