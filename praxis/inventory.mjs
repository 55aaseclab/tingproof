import { join } from 'node:path';
export function projectInventory({id,config,working,workspaceId,storage,reminderSpaces,slidesSpaces,polaris,financeMounts,financeProjectName,intelligenceRuntime,locations,add,file,source,safePath,paths,object}) {
file('听校数据库', 'sqlite', config.dataFile);
    {
      add({ label: '音频文件句柄', kind: 'browser', storageKey: 'IndexedDB: tingproof', description: '本机浏览器保存文件关联，换浏览器后需要重新关联。' });
      add({ label: '原始音频', kind: 'unknown', description: '位于用户选择的原文件位置，服务器未登记其路径；听校数据库不包含媒体。' });
    }
}
