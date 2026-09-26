/** 文件目的：在 Node 环境验证 Workbench 的纯会话转换、分组和安全渲染合同。 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
