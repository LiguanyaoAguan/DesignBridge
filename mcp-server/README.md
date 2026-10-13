# MCP Server（规划阶段）

当前 v0.1 只定义文件交接协议，不提供可运行的 MCP Server，也不宣称已连接任何 MCP 客户端。

计划接口：`get_design`、`get_task`、`submit_result`、`list_verification_reports`。
后续需明确认证、访问控制、写入隔离、输入校验和协议版本兼容。
