import { projectInventory } from './inventory.mjs';
export function createStorageIntegration() { return {
  inventory: { project: projectInventory },
  "rootId": "tingproof",
  "paths": {
    "tingproof": "tingproof.db"
  },
  "sources": [
    {
      "kind": "sqlite",
      "path": "tingproof",
      "target": "tingproof.db",
      "registerDefault": true,
      "nativeSource": "data/tingproof.db"
    }
  ],
  "omissions": [
    "TingProof database excludes original audio and browser file handles; register an original-media directory and relink on the new browser."
  ],
  relocation: {
  "registeredRoots": [
    {
      "target": "tingproof.db",
      "root": true,
      "parent": true
    }
  ],
  "businessBindings": {
    "dataFile": {
      "path": "tingproof",
      "required": false
    }
  }
},
  registrations: [
  {
    "command": "register-media",
    "kind": "directory",
    "target": "original-media",
    "message": "Original media directory registered; browser handles still require relinking."
  }
],
  recovery: { configFields: ['dataFile'], async collect(ctx) { await ctx.register({ kind: 'sqlite', source: ctx.config.dataFile, target: 'tingproof.db' }); } }
}; }
