// 以 tsx 注册 @/ 路径别名后运行区域产线建模 CLI。
import { register } from "tsx/esm/api";

register({ tsconfig: new URL("../../../tsconfig.app.json", import.meta.url).pathname });
await import("./cli.ts");