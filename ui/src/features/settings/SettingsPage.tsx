import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setToken } from "@/lib/api";
import { useI18n } from "@/lib/i18n/provider";
import type { Locale } from "@/lib/i18n";

export default function Settings() {
  const { t, locale, setLocale } = useI18n();
  const [tokenValue, setTokenValue] = useState(localStorage.getItem("gateway_token") || "");
  const [saved, setSaved] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (localStorage.getItem("theme") as "light" | "dark") || "light",
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("theme", theme);
  }, [theme]);

  const handleSaveToken = () => {
    setToken(tokenValue);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const languages: { value: Locale; label: string }[] = [
    { value: "en", label: "English" },
    { value: "zh", label: "中文" },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">{t.settingsTitle}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t.settingsToken}</CardTitle>
          <CardDescription>{t.settingsTokenDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label htmlFor="token">{t.authToken}</Label>
            <Input
              id="token"
              type="password"
              value={tokenValue}
              onChange={(e) => setTokenValue(e.target.value)}
              placeholder={t.settingsTokenPlaceholder}
            />
          </div>
          <Button onClick={handleSaveToken}>
            {saved ? t.settingsSaved : t.settingsSaveToken}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.settingsAppearance}</CardTitle>
          <CardDescription>{t.settingsAppearanceDesc}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            <Button
              variant={theme === "light" ? "default" : "outline"}
              onClick={() => setTheme("light")}
            >
              {t.settingsLight}
            </Button>
            <Button
              variant={theme === "dark" ? "default" : "outline"}
              onClick={() => setTheme("dark")}
            >
              {t.settingsDark}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.settingsLanguage}</CardTitle>
          <CardDescription>{t.settingsLanguageDesc}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            {languages.map((lang) => (
              <Button
                key={lang.value}
                variant={locale === lang.value ? "default" : "outline"}
                onClick={() => setLocale(lang.value)}
              >
                {lang.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
