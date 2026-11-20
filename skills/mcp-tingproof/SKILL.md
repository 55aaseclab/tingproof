---
name: mcp-tingproof
description: Read assigned proofreading tasks, submit permitted corrections and create assignments when authorized. 通过 TingProof MCP 读取已分配音频校正任务并提交文本校正，或在具备分配权限时创建任务。
---

# TingProof assignments

English · [简体中文](#tingproof-任务操作)

External collaborators work only on assignments granted to them. An app login or membership in a space does not grant all tasks, source audio or access to other applications.

| Tool | When and how to use it |
| --- | --- |
| `tingproof_list_assignments` | Discover the tasks actually assigned to the current identity. Use the returned task resource ID. |
| `tingproof_get_assignment` | Read that assignment, permitted materials and current version. Check the correction scope and original segment identifiers. |
| `tingproof_submit_corrections` | Submit corrected text for authorized segments only. Preserve the mappings between segments and time positions. Mark uncertain hearing accurately. |
| `tingproof_create_assignment` | Only on user request and with assignment permission, create a limited task. Define its correction scope and deadline; the caller cannot expand their own privileges. |

Follow the actual schema for revision and idempotency fields, preserving numeric revision types. On conflict, reread the assignment and preserve other corrections. After submitting, read back the target task to verify its correction. Stop on 401/403 or revocation. Do not access unassigned content through host files, the original store, arbitrary URLs or another account.

# TingProof 任务操作

外部协作者只处理已分配任务。应用登录或同一空间身份不等于能访问全部任务、原始音频或其他应用。

| 工具 | 选择与操作 |
|---|---|
| `tingproof_list_assignments` | 发现当前主体真正获分配的任务，使用返回的任务资源 ID。 |
| `tingproof_get_assignment` | 读取目标任务、允许的材料与版本，先核对校正范围和原片段标识。 |
| `tingproof_submit_corrections` | 只提交授权片段的校正文字，保留时间与片段对应关系；不确定的听辨不捏造为事实。 |
| `tingproof_create_assignment` | 仅在有任务分配权限且用户要求时创建一个受限任务；明确校正范围和期限，不能给自己扩权。 |

按真实 schema 提交版本及幂等字段，数字修订号不得变成自由文本。冲突重新读取任务，不覆盖别人的校正。成功提交后回读确认校正归目标任务；401／403或撤销后停止。不能通过宿主文件、原库、任意 URL 或其他账号读取未分配内容。
