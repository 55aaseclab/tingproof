function route({method,pathname,search=''}) {
  const parameters=new URLSearchParams(search),valid=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
  const assets=/^\/assets\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|mjs|css|woff2?|ttf|svg|png|jpe?g|gif|webp|ico)$/.test(pathname);
  const shell=['/','/index.html'].includes(pathname)&&parameters.getAll('assignment').length===1&&parameters.getAll('space').length===1&&valid(parameters.get('assignment'))&&valid(parameters.get('space'))&&[...parameters.keys()].every(key=>['assignment','space'].includes(key));
  return {binding:'native',checks:['GET','HEAD'].includes(method)&&(assets||shell)?[]:['native-projects']};
}

export function createWebIntegration() {
  return {
    "slug": "tingproof",
    "policy": "grant",
    "kind": "proxy",
    "corePages": [{"path": "/business/tingproof/", "file": "praxis/legacy-ui/tingproof.html"}],
    "coreAssets": [{"path": "/tingproof.js", "file": "praxis/legacy-ui/tingproof.js", "type": "application/javascript"}, {"path": "/tingproof.css", "file": "praxis/legacy-ui/tingproof.css", "type": "text/css"}],
    "upgradePolicies": ["native-projects"],
    "legacyPaths": ["/business/tingproof/"],
    "nativePort": 15173,
    "nativePolicies": {
      "native-projects": {
        "resource": "native-projects",
        "actions": [
          "read",
          "assign"
        ],
        "allSpaces": true,
        "wildcard": true,
        "legacyEndpoint": "/api/business/web-resource-access/tingproof/native-projects"
      }
    },
    route
  };
}
