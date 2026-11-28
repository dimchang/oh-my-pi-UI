---
trigger: always_on
---

# 版本号更新规则

1. 每次对本项目进行代码或功能改动时，必须同步更新 [package.json](file:///d:/code/OMP-UI/package.json)（以及 `package-lock.json` 中的 `version`）的版本号。
2. 如果用户没有特别指定版本号或更新级别（如大更新/次版本），默认递增修订号（patch，小版本号），例如 `0.5.41` -> `0.5.42`。
