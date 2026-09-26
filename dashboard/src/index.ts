/** 文件目的：从可读源码构建 Workbench，避免继续依赖只读发布包。 */
import './recovered-runtime.css';
import './recovered-runtime.js';
// Keep the complete Chinese literal pack in the canonical build.  The
// achievements plugin is a Hermes-native bundle, so it cannot rely on the
// Workbench runtime's smaller embedded dictionary alone.
import './zh-locale.js';
import { installKanbanDeleteBoardScope } from './kanban-delete-board-scope';

installKanbanDeleteBoardScope();

import "./project-navigation.css";
import "./cron-mobile.css";
import { installWorkbenchVersionSettings } from './workbench-version-settings';

installWorkbenchVersionSettings();

import './minecraft-sidebar.css';
import './minecraft-theme.css';
