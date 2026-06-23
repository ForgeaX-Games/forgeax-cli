// @desc Default base.env template for team/env/

export function defaultBaseEnvTemplate(): string {
  return [
    "# team/env/base.env",
    "# 在此添加 team 级自定义环境变量，格式 KEY=VALUE",
    "# 注意：值不要用引号包裹（Docker 模式下 --env-file 会把引号原样传入）",
    "",
  ].join("\n");
}
