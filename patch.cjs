const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf-8');

code = `import defaultData from './defaultData.json';\n` + code;

code = code.replace(/const defaultNetworkNodes: Record<string, NetworkNode> = \{[\s\S]*?const defaultClientNodes/g, `const defaultNetworkNodes: Record<string, NetworkNode> = defaultData.networkNodes as any;\n\nconst defaultClientNodes`);

code = code.replace(/const defaultClientNodes: Record<string, ClientNode> = \{[\s\S]*?const defaultWalls/g, `const defaultClientNodes: Record<string, ClientNode> = defaultData.clientNodes as any;\n\nconst defaultWalls`);

code = code.replace(/const defaultWalls: Wall\[\] = \[[\s\S]*?\];/g, `const defaultWalls: Wall[] = defaultData.walls as any;`);

code = code.replace(/const PRESET_DEVICE_IMAGES = \{[\s\S]*?\};\n/g, ``);

code = code.replace(/return \[\s*\{\s*id: 'tpl_modem_1'[\s\S]*?\}\s*\];\s*\}\);/g, `return defaultData.deviceTemplates as any;\n  });`);

fs.writeFileSync('src/App.tsx', code);
console.log('App.tsx patched');
