package repository

import "strings"

// 2026-10-08:素材库筛选与项目按节点数排序原来直接写 SQLite 的 json_extract /
// json_type / json_array_length,Postgres 上不存在(SQLSTATE 42883)。这里按方言生成
// 等价表达式。列名与路径都是编译期常量,从不拼接用户输入。

// pgJSONDoc 把 TEXT 列安全地转成 jsonb:空串、NULL、非法 JSON 都视为 NULL,不让整条查询报错。
func pgJSONDoc(column string) string {
	return "(CASE WHEN " + column + " IS JSON THEN " + column + "::jsonb END)"
}

func pgJSONPath(path []string) string {
	return "'{" + strings.Join(path, ",") + "}'"
}

// sqliteJSONDoc 同理:非法/空 JSON 视为 NULL(json_extract 遇到 malformed JSON 会让整条查询报错)。
func sqliteJSONDoc(column string) string {
	return "(CASE WHEN json_valid(" + column + ") THEN " + column + " END)"
}

func sqliteJSONPath(path []string) string {
	return "'$." + strings.Join(path, ".") + "'"
}

// jsonTextSQL 取路径上的值作为文本(标量原样,对象/数组为 JSON 文本;缺失为 NULL)。
func jsonTextSQL(dialect, column string, path ...string) string {
	if dialect == "postgres" {
		return "(" + pgJSONDoc(column) + " #>> " + pgJSONPath(path) + ")"
	}
	return "CAST(json_extract(" + sqliteJSONDoc(column) + ", " + sqliteJSONPath(path) + ") AS TEXT)"
}

// jsonIsStringSQL 判断路径上的值是否为 JSON 字符串。
func jsonIsStringSQL(dialect, column string, path ...string) string {
	if dialect == "postgres" {
		return "(jsonb_typeof(" + pgJSONDoc(column) + " #> " + pgJSONPath(path) + ") = 'string')"
	}
	return "(json_type(" + sqliteJSONDoc(column) + ", " + sqliteJSONPath(path) + ") = 'text')"
}

// jsonArrayLengthSQL 是路径上数组的长度;缺失或不是数组时为 0。
func jsonArrayLengthSQL(dialect, column string, path ...string) string {
	if dialect == "postgres" {
		value := pgJSONDoc(column) + " #> " + pgJSONPath(path)
		return "(CASE WHEN jsonb_typeof(" + value + ") = 'array' THEN jsonb_array_length(" + value + ") ELSE 0 END)"
	}
	return "COALESCE(json_array_length(" + sqliteJSONDoc(column) + ", " + sqliteJSONPath(path) + "), 0)"
}

// jsonTruthySQL 判断路径上的值是否为 true / 1 / "true" / "1"(素材收藏标记的历史写法)。
func jsonTruthySQL(dialect, column string, path ...string) string {
	if dialect == "postgres" {
		return "(" + jsonTextSQL(dialect, column, path...) + " IN ('true', '1'))"
	}
	return "(json_extract(" + sqliteJSONDoc(column) + ", " + sqliteJSONPath(path) + ") IN (1, 'true', '1'))"
}
