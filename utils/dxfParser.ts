import { DxfData, DxfEntity, EntityType, Point } from '../types';

/**
 * Helper to decode DXF string format.
 * Handles \U+XXXX unicode, MTEXT formatting {\W...;}, and standard symbols like %%d.
 * NOW SUPPORTS: \M+1XXXX multibyte sequences using provided encoding (e.g. GBK).
 */
const decodeDxfString = (str: string, encoding: string = 'utf-8'): string => {
  let s = str;

  // 1. Multibyte Decoding (\M+1XXXX) - Must be done before other replacements
  // Matches \M+1 followed by 4 hex digits (represents bytes in the target encoding)
  s = s.replace(/\\M\+1([0-9A-Fa-f]{4})/g, (_, hex) => {
    try {
      // Parse hex into bytes
      const bytes = new Uint8Array(2);
      bytes[0] = parseInt(hex.slice(0, 2), 16);
      bytes[1] = parseInt(hex.slice(2, 4), 16);
      // Decode bytes using the selected encoding (e.g. 'gbk')
      return new TextDecoder(encoding).decode(bytes);
    } catch (e) {
      // Fallback: treat as unicode code point or raw
      return String.fromCharCode(parseInt(hex, 16)); 
    }
  });

  // 2. Unicode Decoding (\U+XXXX)
  s = s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  // 3. MTEXT Formatting Stripping
  s = s.replace(/\\P/gi, '\n'); // New Paragraph
  s = s.replace(/\\[ACFHQTW][^;]*;/gi, ''); // Formatting props
  s = s.replace(/\\S([^;]*);/gi, '$1'); // Stacking
  s = s.replace(/\\[LOKlok]/g, ''); // Switches
  s = s.replace(/[{}]/g, ''); // Grouping

  // 4. Standard Symbols
  s = s.replace(/%%c/gi, 'ø');
  s = s.replace(/%%d/gi, '°');
  s = s.replace(/%%p/gi, '±');
  s = s.replace(/%%u/gi, ''); 
  s = s.replace(/%%o/gi, '');

  return s.trim();
};

/**
 * A streamlined DXF parser.
 * Supports TABLES (Layers), BLOCKS (Definitions), and ENTITIES (Geometry).
 */
export const parseDxf = (dxfContent: string, encoding: string = 'utf-8'): DxfData => {
  const lines = dxfContent.split(/\r\n|\r|\n/);
  const entities: DxfEntity[] = [];
  const blocks: Record<string, DxfEntity[]> = {};
  const layers = new Set<string>();

  let section = 'NONE';
  let tableType = 'NONE';
  
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

    // --- TABLES SECTION ---
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
            layers.add(decodeDxfString(value, encoding));
        }
      }
    }

    // --- BLOCKS SECTION ---
    if (section === 'BLOCKS') {
       if (code === 0) {
          if (value === 'BLOCK') {
             activeBlockName = null;
          } else if (value === 'ENDBLK') {
             if (currentEntity && activeBlockName && blocks[activeBlockName]) {
                 finalizeEntity(currentEntity, blocks[activeBlockName], layers);
                 currentEntity = null;
             }
             activeBlockName = null;
          } else {
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
           if (currentEntity) {
               if (inPolyline && currentEntity._originalType === 'POLYLINE') {
                   parsePolylineProperty(code, value, currentEntity, encoding);
               } else {
                   parseProperty(code, value, currentEntity, encoding);
               }
           }
       } else {
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
        if (inPolyline && currentEntity._originalType === 'POLYLINE') {
            parsePolylineProperty(code, value, currentEntity, encoding);
        } else {
            parseProperty(code, value, currentEntity, encoding);
        }
      }
    }
  }

  if (currentEntity && section === 'ENTITIES') {
    finalizeEntity(currentEntity, entities, layers);
  }

  return {
    entities,
    layers: Array.from(layers).sort(),
    blocks
  };
};

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

    if (typeStr === 'POLYLINE') {
        if (current && !inPoly) onFinalize(current);
        setInPolyline(true);
        setCurrent({ type: EntityType.LWPOLYLINE, layer: '0', vertices: [], _originalType: 'POLYLINE' });
        return;
    } 
    
    if (typeStr === 'VERTEX') return;
    
    if (typeStr === 'SEQEND') {
        if (inPoly && current) {
            onFinalize(current);
            setCurrent(null);
            setInPolyline(false);
        }
        return;
    }

    if (inPoly) {
        if (current) onFinalize(current);
        setInPolyline(false);
    } else if (current) {
        onFinalize(current);
    }

    setCurrent({ type: mapType(typeStr), layer: '0', vertices: [], _originalType: typeStr });
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

const parsePolylineProperty = (code: number, value: string, entity: Partial<DxfEntity>, encoding: string) => {
    const valNum = parseFloat(value);
    if (code === 8) entity.layer = decodeDxfString(value, encoding);
    else if (code === 70) { if ((parseInt(value) & 1) === 1) entity.closed = true; }
    else if (code === 10) {
        if (!entity.vertices) entity.vertices = [];
        entity.vertices.push({ x: valNum, y: 0 });
    } else if (code === 20) {
        if (entity.vertices && entity.vertices.length > 0) {
            entity.vertices[entity.vertices.length - 1].y = valNum;
        }
    }
};

const parseProperty = (code: number, value: string, entity: Partial<DxfEntity>, encoding: string) => {
  const valNum = parseFloat(value);
  
  switch (code) {
    case 8: entity.layer = decodeDxfString(value, encoding); break;
    
    case 10: 
      if (!entity.start) entity.start = { x: 0, y: 0 };
      if (!entity.center) entity.center = { x: 0, y: 0 };
      if (entity.type === EntityType.LWPOLYLINE) entity.vertices?.push({ x: valNum, y: 0 });
      else { entity.start.x = valNum; entity.center.x = valNum; }
      break;
    case 20: 
      if (entity.type === EntityType.LWPOLYLINE) {
        const lastV = entity.vertices ? entity.vertices[entity.vertices.length - 1] : null;
        if (lastV) lastV.y = valNum;
      } else {
        if (entity.start) entity.start.y = valNum;
        if (entity.center) entity.center.y = valNum;
      }
      break;
      
    case 11: 
       if (entity._originalType === 'MTEXT') {
           if (!entity.xAxis) entity.xAxis = { x: 0, y: 0 };
           entity.xAxis.x = valNum;
       } else {
           if (!entity.end) entity.end = { x: 0, y: 0 };
           entity.end.x = valNum;
       }
       break;
    case 21: 
       if (entity._originalType === 'MTEXT') {
           if (!entity.xAxis) entity.xAxis = { x: 0, y: 0 };
           entity.xAxis.y = valNum;
       } else {
           if (!entity.end) entity.end = { x: 0, y: 0 };
           entity.end.y = valNum;
       }
       break;

    case 13: 
      if (!entity.measureStart) entity.measureStart = { x: 0, y: 0 };
      entity.measureStart.x = valNum; break;
    case 23: 
      if (!entity.measureStart) entity.measureStart = { x: 0, y: 0 };
      entity.measureStart.y = valNum; break;
    case 14: 
      if (!entity.measureEnd) entity.measureEnd = { x: 0, y: 0 };
      entity.measureEnd.x = valNum; break;
    case 24: 
      if (!entity.measureEnd) entity.measureEnd = { x: 0, y: 0 };
      entity.measureEnd.y = valNum; break;

    case 40: entity.radius = valNum; break;
    case 41: 
      if (!entity.scale) entity.scale = { x: valNum, y: valNum };
      else entity.scale.x = valNum;
      break;
    case 42: 
      if (!entity.scale) entity.scale = { x: 1, y: 1 };
      entity.scale.y = valNum;
      break;

    case 50: // Angle / Rotation
      if (entity._originalType === 'MTEXT') {
          // HEURISTIC: Fix for incorrect Text Direction
          // Spec says MTEXT angle is in Radians. However, many files (and some exporters) use Degrees.
          // If value is > 2PI (6.28), it is definitely Degrees (e.g. 90, 270).
          // If value is exactly 0, it works either way.
          // We assume if it's large, it's degrees.
          if (Math.abs(valNum) > 6.28319) {
             entity.startAngle = valNum; // Already degrees
          } else {
             entity.startAngle = valNum * (180 / Math.PI); // Convert Rad -> Deg
          }
      } else if (entity.type === EntityType.INSERT) {
          entity.rotation = valNum;
      } else {
          // TEXT angle is in degrees
          entity.startAngle = valNum; 
      }
      break;
      
    case 51: entity.endAngle = valNum; break;
    case 70: if (entity.type === EntityType.LWPOLYLINE && (parseInt(value) & 1) === 1) entity.closed = true; break;
    case 1: entity.text = decodeDxfString(value, encoding); break;
    case 2: if (entity.type === EntityType.INSERT) entity.blockName = value; break;
  }
};

const finalizeEntity = (raw: Partial<DxfEntity>, list: DxfEntity[], layers: Set<string>) => {
  if (raw.type === EntityType.UNKNOWN) return;
  
  // Prefer MTEXT direction vector if present and non-zero
  if (raw._originalType === 'MTEXT' && raw.xAxis && (raw.xAxis.x !== 0 || raw.xAxis.y !== 0)) {
      raw.startAngle = Math.atan2(raw.xAxis.y, raw.xAxis.x) * (180 / Math.PI);
  }

  if (raw.layer) layers.add(raw.layer);
  list.push(raw as DxfEntity);
};
