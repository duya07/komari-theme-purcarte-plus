import { useContext, useCallback, useEffect, useRef } from "react";
import { ConfigContext } from "./ConfigContext";
import type { ConfigContextType } from "./ConfigContext";
import { DEFAULT_CONFIG } from "./default";
import { defaultTexts, otherTexts } from "./locales";
import i18next from "i18next";
import { useTranslation } from "react-i18next";
import { parseCustomTexts, unflattenObject } from "@/utils/localeUtils";

/**
 * 安全地获取嵌套对象的属性
 * @param obj 要查询的对象
 * @param path 属性路径
 * @param defaultValue 如果解析值为 undefined，则返回此值
 * @returns 解析后的值
 */
const get = (obj: any, path: string, defaultValue: any = undefined) => {
  const keys = path.split(".");
  let result = obj;
  for (const key of keys) {
    result = result?.[key];
    if (result === undefined) {
      return defaultValue;
    }
  }
  return result;
};

type Paths<T, P extends string = ""> = T extends object
  ? {
      [K in keyof T]: T[K] extends object
        ? Paths<T[K], `${P}${Exclude<K, symbol>}.`>
        : `${P}${Exclude<K, symbol>}`;
    }[keyof T]
  : never;

type MergedTexts = typeof defaultTexts & typeof otherTexts;
type LocaleKeys = Paths<MergedTexts>;

/**
 * 使用全局配置 Hook，用于获取当前应用配置
 * @returns 配置对象（合并了默认配置，确保所有属性都有值）
 */
export function useAppConfig(): ConfigContextType {
  const config = useContext(ConfigContext);
  // 从上下文中过滤掉 undefined/null 值，以防止
  // 覆盖 DEFAULT_CONFIG 的默认值（修复 React 错误 #130）
  const safeConfig = Object.fromEntries(
    Object.entries(config).filter(([, v]) => v !== undefined && v !== null)
  );
  return { ...DEFAULT_CONFIG, ...safeConfig } as ConfigContextType;
}

/**
 * 使用本地化文本 Hook（桥接 i18next）
 * 优先级：i18next 翻译 > 自定义文本覆盖 > locales.ts 默认值
 * @returns t 函数用于获取翻译文本，i18n 实例用于语言切换
 */
export function useLocale() {
  const appConfig = useAppConfig();
  const { texts } = appConfig;
  const rawCustomTexts = appConfig.customTexts;
  const { i18n } = useTranslation();
  const prevCustomTextsRef = useRef<string | null>(null);

  // 仅注入后台自定义文本覆盖到 i18next，而非完整的中文默认文本
  // 旧版注入完整 texts 会污染非中文语言包，导致切换语言后回退中文
  useEffect(() => {
    if (rawCustomTexts === prevCustomTextsRef.current) return;
    prevCustomTextsRef.current = rawCustomTexts;

    if (!rawCustomTexts) return;
    const parsed = parseCustomTexts(rawCustomTexts);
    if (Object.keys(parsed).length === 0) return;

    // 转换 {param} 为 {{param}} 以适配 i18next 插值格式
    const converted: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") {
        converted[k] = v.replace(/(?<!\{)\{([^{}]+)\}(?!\})/g, "{{$1}}");
      } else {
        converted[k] = v;
      }
    }
    const nested = unflattenObject(converted);

    // 注入到所有语言包，使管理员覆盖全局生效
    const languages = Object.keys(i18next.options?.resources || {});
    for (const lang of languages) {
      i18next.addResourceBundle(lang, "translation", nested, true, true);
    }
  }, [rawCustomTexts]);

  const t = useCallback(
    (key: LocaleKeys | (string & {}), params?: Record<string, string | number>): string => {
      // 使用 i18next 翻译（已包含 JSON locale + customTexts 覆盖）
      const result = i18next.t(key as string, params as any);

      // 如果 i18next 返回了 key 本身（未找到翻译），回退到 texts 对象
      if (result === key) {
        const text = get(texts, key, key);
        if (typeof text !== "string") return key as string;
        if (params) {
          return Object.entries(params).reduce(
            (acc, [paramKey, paramValue]) =>
              acc.replace(new RegExp(`\\{${paramKey}\\}`, "g"), String(paramValue)),
            text
          );
        }
        return text;
      }

      return result as string;
    },
    [texts]
  );

  return { t, i18n };
}
