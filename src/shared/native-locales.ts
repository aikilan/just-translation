import { resources } from './locales.ts';

/** Chrome owns metadata locale selection; both Chinese browser variants use simplified text. */
export function nativeLocaleMessages(): Record<string, Record<string, { message: string }>> {
  return Object.fromEntries(
    Object.entries({
      zh_CN: resources['zh-CN'],
      zh_TW: resources['zh-CN'],
      en: resources.en,
      fr: resources.fr,
      de: resources.de,
      ar: resources.ar,
    }).map(([locale, catalog]) => [
      locale,
      {
        extensionName: { message: catalog['只是翻译'] },
        extensionDescription: {
          message:
            catalog['无需 API 配置即可使用 Google 或 Microsoft 免费翻译，也可连接自己的 AI。'],
        },
        translateCommand: { message: catalog['翻译或恢复当前网页'] },
      },
    ]),
  );
}
