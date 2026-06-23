import { Card, CardContent } from "@/components/ui/card";
import { useT } from "@/lib/i18n/provider";
import { Radio } from "lucide-react";

export default function ChannelsPage() {
  const t = useT();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Radio className="h-6 w-6" />
        <h1 className="text-2xl font-bold tracking-tight">{t.navChannels}</h1>
      </div>
      <Card>
        <CardContent className="py-16 text-center">
          <p className="text-lg font-medium text-muted-foreground">{t.comingSoon}</p>
          <p className="mt-2 text-sm text-muted-foreground/70">
            Channel lifecycle management is under development.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
