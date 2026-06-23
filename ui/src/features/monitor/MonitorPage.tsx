import { useParams, Link } from "react-router";
import { useState, useRef, useEffect, useCallback } from "react";
import { useT } from "@/lib/i18n/provider";
import { useWebSocket } from "@/hooks/use-ws";
import { useAgentMonitor } from "@/hooks/use-agent-monitor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/spinner";
import type { RendererMessage, ToolCallMessage } from "@/lib/event-engine/types";
import { ArrowLeft, Play, Pause, SkipForward, Bot, Brain } from "lucide-react";
import { StreamDisplay } from "./StreamDisplay";

export default function MonitorPage() {
  const { id: instanceId, agent: agentId } = useParams<{ id: string; agent: string }>();
  // Route requires both params; null when an upstream router glitch lands here
  // without them. Narrow once so the content tree can rely on `string`.
  if (!instanceId || !agentId) return null;
  return <MonitorContent instanceId={instanceId} agentId={agentId} />;
}

function MonitorContent({ instanceId, agentId }: { instanceId: string; agentId: string }) {
  const t = useT();
  const token = localStorage.getItem("gateway_token") || undefined;
  const { subscribe } = useWebSocket(token);

  const { turns, loading, streamText, isThinking } = useAgentMonitor({
    instanceId,
    agentId,
    subscribe,
  });

  const [selectedNode, setSelectedNode] = useState<RendererMessage | null>(null);
  const [playbackMode, setPlaybackMode] = useState<"live" | "replay">("live");
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const timelineRef = useRef<HTMLDivElement>(null);

  const visibleTurns = playbackMode === "live" ? turns : turns.slice(0, playbackIndex + 1);

  useEffect(() => {
    if (playbackMode === "live" && timelineRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
    }
  }, [turns, playbackMode]);

  useEffect(() => {
    if (!isPlaying || playbackMode !== "replay") return;
    if (playbackIndex >= turns.length - 1) {
      setIsPlaying(false);
      return;
    }
    const timer = setTimeout(() => {
      setPlaybackIndex(prev => Math.min(prev + 1, turns.length - 1));
    }, 1000 / speed);
    return () => clearTimeout(timer);
  }, [isPlaying, playbackIndex, turns.length, speed, playbackMode]);

  const jumpToLive = useCallback(() => {
    setPlaybackMode("live");
    setIsPlaying(false);
    setSelectedNode(null);
  }, []);

  const startReplay = useCallback(() => {
    setPlaybackMode("replay");
    setPlaybackIndex(0);
    setIsPlaying(true);
  }, []);

  if (loading) return <LoadingState />;

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b shrink-0">
        <Link to={`/admin/instances/${instanceId}`}>
          <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <h1 className="text-lg font-bold">{t.monTitle}</h1>
        <Badge variant="outline">{instanceId}</Badge>
        <Badge variant="secondary">{agentId}</Badge>
        <div className="ml-auto flex items-center gap-2">
          {playbackMode === "live" ? (
            <>
              <Badge variant="success" className="animate-pulse">{t.monLive}</Badge>
              <Button size="sm" variant="outline" onClick={startReplay}>
                <Play className="h-3 w-3" /> {t.monReplay}
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => setIsPlaying(!isPlaying)}>
                {isPlaying ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              </Button>
              <input
                type="range"
                min={0}
                max={Math.max(turns.length - 1, 0)}
                value={playbackIndex}
                onChange={e => { setPlaybackIndex(+e.target.value); setIsPlaying(false); }}
                className="w-32"
              />
              <span className="text-xs text-muted-foreground">{playbackIndex + 1}/{turns.length}</span>
              <select value={speed} onChange={e => setSpeed(+e.target.value)} className="text-xs border rounded px-1 py-0.5">
                <option value={1}>1x</option>
                <option value={2}>2x</option>
                <option value={4}>4x</option>
              </select>
              <Button size="sm" variant="outline" onClick={jumpToLive}>
                <SkipForward className="h-3 w-3" /> {t.monJumpToLive}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Three column layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Stream display */}
        <div ref={timelineRef} className="flex-1 overflow-auto p-4 border-r">
          {visibleTurns.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <Bot className="h-12 w-12 mb-4 opacity-50" />
              <p>{t.monNoTurns}</p>
            </div>
          ) : (
            <StreamDisplay
              turns={visibleTurns}
              streamText={playbackMode === "live" ? streamText : undefined}
              isThinking={isThinking}
              selectedMessage={selectedNode}
              onSelect={setSelectedNode}
            />
          )}
        </div>

        {/* Detail Inspector */}
        <div className="w-80 shrink-0 overflow-auto p-4 bg-muted/30">
          {selectedNode ? (
            <DetailInspector message={selectedNode} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm">
              <p>{t.monSelectNode}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


function DetailInspector({ message }: { message: RendererMessage }) {
  const kind = message.kind;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{kind}</Badge>
        <span className="text-xs text-muted-foreground">{message.agent}</span>
        <span className="text-xs text-muted-foreground">{new Date(message.timestamp).toLocaleTimeString()}</span>
      </div>

      {kind === "tool_call" && <ToolCallDetail message={message as ToolCallMessage} />}
      {kind === "assistant_complete" && <AssistantDetail message={message as any} />}
      {kind === "user_input" && <UserInputDetail message={message as any} />}
      {kind === "system" && <SystemDetail message={message as any} />}
      {kind === "tool_result" && <ToolResultDetail message={message as any} />}
    </div>
  );
}

function ToolCallDetail({ message }: { message: ToolCallMessage }) {
  return (
    <div className="space-y-2">
      <div>
        <h4 className="text-xs font-medium text-muted-foreground mb-1">Name</h4>
        <p className="text-sm font-mono">{message.name}</p>
      </div>
      <div>
        <h4 className="text-xs font-medium text-muted-foreground mb-1">Status</h4>
        <Badge variant={message.status === "done" ? "success" : message.status === "error" ? "destructive" : "secondary"}>
          {message.status}
        </Badge>
        {message.durationMs != null && <span className="ml-2 text-xs text-muted-foreground">{message.durationMs}ms</span>}
      </div>
      {message.subagentId && (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground mb-1">Subagent</h4>
          <p className="text-sm font-mono">{message.subagentId}</p>
        </div>
      )}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground mb-1">Arguments</h4>
        <pre className="text-xs bg-muted rounded-md p-2 overflow-auto max-h-48 font-mono whitespace-pre-wrap">
          {JSON.stringify(message.args, null, 2)}
        </pre>
      </div>
      {message.resultContent && (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground mb-1">Result</h4>
          <pre className="text-xs bg-muted rounded-md p-2 overflow-auto max-h-48 font-mono whitespace-pre-wrap">
            {message.resultContent}
          </pre>
        </div>
      )}
    </div>
  );
}

function AssistantDetail({ message }: { message: { text: string; thinking: string } }) {
  return (
    <div className="space-y-2">
      {message.thinking && (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1"><Brain className="h-3 w-3" /> Thinking</h4>
          <pre className="text-xs bg-muted rounded-md p-2 overflow-auto max-h-48 font-mono whitespace-pre-wrap opacity-70">
            {message.thinking}
          </pre>
        </div>
      )}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground mb-1">Message</h4>
        <pre className="text-xs bg-muted rounded-md p-2 overflow-auto max-h-64 font-mono whitespace-pre-wrap">
          {message.text}
        </pre>
      </div>
    </div>
  );
}

function UserInputDetail({ message }: { message: { text: string; source: string; isSteer: boolean } }) {
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Badge variant="outline">{message.source}</Badge>
        {message.isSteer && <Badge variant="secondary">steer</Badge>}
      </div>
      <pre className="text-xs bg-muted rounded-md p-2 overflow-auto max-h-64 font-mono whitespace-pre-wrap">
        {message.text}
      </pre>
    </div>
  );
}

function SystemDetail({ message }: { message: { text: string; source: string } }) {
  return (
    <div className="space-y-2">
      <Badge variant="outline">{message.source}</Badge>
      <pre className="text-xs bg-muted rounded-md p-2 overflow-auto max-h-48 font-mono whitespace-pre-wrap">
        {message.text}
      </pre>
    </div>
  );
}

function ToolResultDetail({ message }: { message: { callId: string; name: string; content: string; durationMs: number } }) {
  return (
    <div className="space-y-2">
      <div>
        <h4 className="text-xs font-medium text-muted-foreground mb-1">Tool</h4>
        <p className="text-sm font-mono">{message.name}</p>
      </div>
      <div>
        <h4 className="text-xs font-medium text-muted-foreground mb-1">Duration</h4>
        <p className="text-sm">{message.durationMs}ms</p>
      </div>
      <div>
        <h4 className="text-xs font-medium text-muted-foreground mb-1">Content</h4>
        <pre className="text-xs bg-muted rounded-md p-2 overflow-auto max-h-48 font-mono whitespace-pre-wrap">
          {message.content}
        </pre>
      </div>
    </div>
  );
}
