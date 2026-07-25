// 需要加载位于 `/Users/chii_magnus/.codex/skills` 中的skills。
// 我希望是渐进式加载，也就是说，在notionAI调用这个mcp的时候，先默认强制加载所有的skills中的description字段。
// 这样就知道都有哪些skills可以使用了，然后再根据需要加载具体的skills全部内容。

// 调用codegraph cli的tool
// 写介绍就行，不需要真的实现吧？
// 或许我们打算实现的`tools/load_skills.mjs`其实也可以做成类似于这个文件一样的？
// 每个codex skill对应一个tool mjs文件？
