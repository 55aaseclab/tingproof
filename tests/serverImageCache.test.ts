import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createTingProofServer } from "../server/main.js";

const policy = "private, max-age=3600, must-revalidate";
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tingproof-image-cache-"));
  const image = join(root, "photo.svg");
  writeFileSync(image, '<svg xmlns="http://www.w3.org/2000/svg"><title>synthetic</title></svg>');
  writeFileSync(join(root, "index.html"), "<h1>Synthetic TingProof</h1>");
  const instance = createTingProofServer({ dbPath: join(root,"synthetic.db"), distDir: root });
  await new Promise<void>(resolve => instance.server.listen(0,"127.0.0.1",resolve));
  const address = instance.server.address();
  if (!address || typeof address === "string") throw new Error("Test server has no TCP port.");
  return {root,image,base:"http://127.0.0.1:"+address.port,close:async()=>{
    await new Promise<void>(resolve=>{instance.server.close(()=>resolve());instance.server.closeAllConnections();});
    rmSync(root,{recursive:true,force:true});
  }};
}

describe("production static image cache", () => {
  it("serves private validators, HEAD and body-free conditional 304 responses", async () => {
    const {base,close}=await fixture();
    try {
      const first=await fetch(base+"/photo.svg");
      const body=await first.text();
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toBe(policy);
      expect(first.headers.get("vary")).toBe("Authorization");
      const tag=first.headers.get("etag")!;
      expect(tag).toMatch(/^W\/".+"$/);
      expect(Number.isFinite(Date.parse(first.headers.get("last-modified")!))).toBe(true);
      const head=await fetch(base+"/photo.svg",{method:"HEAD"});
      expect(head.headers.get("etag")).toBe(tag);
      expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
      expect(await head.text()).toBe("");
      for (const method of ["GET","HEAD"]) {
        const response=await fetch(base+"/photo.svg",{method,headers:{"If-None-Match":tag}});
        expect(response.status).toBe(304);
        for(const name of ["etag","last-modified","vary","content-type","cache-control"]) expect(response.headers.get(name)).toBe(first.headers.get(name));
        expect(response.headers.get("content-length")).toBe(null);
        expect(await response.text()).toBe("");
      }
    } finally {await close();}
  });

  it("supports weak/list/star/date conditions with correct tag precedence and refreshes changed files", async () => {
    const {base,image,close}=await fixture();
    try {
      const first=await fetch(base+"/photo.svg");
      const tag=first.headers.get("etag")!;
      for(const value of ["*",tag.replace(/^W\//,""),'"another", '+tag]) expect((await fetch(base+"/photo.svg",{headers:{"If-None-Match":value}})).status).toBe(304);
      expect((await fetch(base+"/photo.svg",{headers:{"If-Modified-Since":first.headers.get("last-modified")!}})).status).toBe(304);
      expect((await fetch(base+"/photo.svg",{headers:{"If-Modified-Since":"invalid"}})).status).toBe(200);
      expect((await fetch(base+"/photo.svg",{headers:{"If-None-Match":'"mismatch"',"If-Modified-Since":"Wed, 01 Jan 2100 00:00:00 GMT"}})).status).toBe(200);
      expect((await fetch(base+"/photo.svg",{headers:{"If-None-Match":tag,"If-Modified-Since":"Thu, 01 Jan 1970 00:00:00 GMT"}})).status).toBe(304);
      writeFileSync(image,"<svg><title>changed synthetic image body</title></svg>");
      const changed=await fetch(base+"/photo.svg",{headers:{"If-None-Match":tag}});
      expect(changed.status).toBe(200);
      expect(changed.headers.get("etag")).not.toBe(tag);
      expect(await changed.text()).toContain("changed synthetic");
    } finally {await close();}
  });

  it("classifies canonical symlink targets and rejects files outside the static tree", async () => {
    const {base,root,close}=await fixture();
    const outside=mkdtempSync(join(tmpdir(),"tingproof-outside-image-"));
    try {
      writeFileSync(join(outside,"outside.svg"),"<svg><title>outside synthetic asset</title></svg>");
      symlinkSync(join(root,"index.html"),join(root,"looks-like-image.png"));
      symlinkSync(join(root,"photo.svg"),join(root,"looks-like-text.txt"));
      symlinkSync(join(outside,"outside.svg"),join(root,"escape.png"));
      const html=await fetch(base+"/looks-like-image.png",{headers:{"If-None-Match":"*"}});
      expect(html.status).toBe(200);
      expect(html.headers.get("content-type")).toContain("text/html");
      expect(html.headers.get("cache-control")).toBe("no-store");
      expect(html.headers.get("etag")).toBe(null);
      const image=await fetch(base+"/looks-like-text.txt");
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/svg+xml");
      expect(image.headers.get("cache-control")).toBe(policy);
      for(const method of ["GET","HEAD"]) {
        const escaped=await fetch(base+"/escape.png",{method,headers:{"If-None-Match":"*"}});
        expect([403,404]).toContain(escaped.status);
        expect(escaped.headers.get("cache-control")).toBe("no-store");
        expect(escaped.headers.get("etag")).toBe(null);
        expect(await escaped.text()).not.toContain("outside synthetic");
      }
    } finally {await close();rmSync(outside,{recursive:true,force:true});}
  });

  it("recognizes image formats but never caches SPA fallbacks, API or static errors as images", async () => {
    const {base,root,close}=await fixture();
    try {
      for(const [extension,type] of Object.entries({jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",webp:"image/webp",gif:"image/gif",avif:"image/avif",ico:"image/x-icon"})) {
        writeFileSync(join(root,"synthetic."+extension),"synthetic image bytes");
        const response=await fetch(base+"/synthetic."+extension);
        expect(response.headers.get("content-type")).toBe(type);
        expect(response.headers.get("cache-control")).toBe(policy);
      }
      for(const [path,method,status] of [["/","GET",200],["/missing.png","GET",200],["/api/projects","GET",200],["/photo.svg","POST",405]] as const) {
        const response=await fetch(base+path,{method,headers:{"If-None-Match":"*"}});
        expect(response.status).toBe(status);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("etag")).toBe(null);
        if(path==="/missing.png") expect(response.headers.get("content-type")).toContain("text/html");
      }
    } finally {await close();}
  });
});
