# shellcheck shell=bash
# User configuration bootstrap (interactive when stdin is a TTY, otherwise silent):
#   - default model fallback chain → agenteam.json#models.model
#   - LLM key coverage validation → llm_key.json (warn-only, never blocks)
#   - tool keys (tavily / memory_* / git_api_*) → tools.json

# ── Default model configuration ──
MODELS_JSON="$AGENTEAM_DIR/key/models.json"

# Read current default model chain from agenteam.json
DEFAULT_MODEL=$(AGENTEAM_CFG="$AGENTEAM_CFG" node -e "
  try {
    const c = JSON.parse(require('fs').readFileSync(process.env.AGENTEAM_CFG, 'utf-8'));
    const m = c.models && c.models.model;
    // treat null, 'null', empty string, undefined as not set
    if (Array.isArray(m)) {
      const valid = m.filter(x => x && String(x) !== 'null').map(String);
      if (valid.length > 0) process.stdout.write(valid.join(' -> '));
    } else if (m && String(m) !== 'null') {
      process.stdout.write(String(m));
    }
  } catch {}
" 2>/dev/null || true)

format_model_chain() {
  printf '%s\n' "$1" | node -e "
    const fs = require('fs');
    const models = fs.readFileSync(0, 'utf-8').split('\n').filter(Boolean);
    process.stdout.write(models.join(' -> '));
  "
}

if [ -n "$DEFAULT_MODEL" ]; then
  ok "Default model: $DEFAULT_MODEL"
else
  echo ""
  warn "No default model configured in agenteam.json"

  if [ ! -t 0 ]; then
    warn "Non-interactive mode — skipping model selection"
  elif [ ! -f "$MODELS_JSON" ]; then
    warn "models.json not found — cannot list available models"
    warn "Please create $MODELS_JSON with your model configurations"
  else
    # Interactive model selection loop
    chosen_model=""
    while true; do
      # Read model list from models.json
      MODEL_LIST=$(MODELS_JSON="$MODELS_JSON" node -e "
        try {
          const models = JSON.parse(require('fs').readFileSync(process.env.MODELS_JSON, 'utf-8'));
          process.stdout.write(Object.keys(models).join('\n'));
        } catch {}
      " 2>/dev/null || true)

      if [ -z "$MODEL_LIST" ]; then
        warn "No models found in models.json"
        break
      fi

      # Display numbered list
      echo ""
      echo "  Select your default fallback model chain:"
      if [ -n "$chosen_model" ]; then
        echo "  Current chain: $(format_model_chain "$chosen_model")"
        echo ""
      fi
      echo ""
      _i=1
      while IFS= read -r _model_name; do
        printf "    ${GREEN}%d${NC}) %s\n" "$_i" "$_model_name"
        _i=$((_i + 1))
      done <<< "$MODEL_LIST"
      printf "    ${YELLOW}0${NC}) Enter a custom model name\n"
      echo ""
      printf "  Enter number to append, ${YELLOW}Enter${NC} to finish, or ${YELLOW}skip${NC} to continue without setting: "
      read -r model_input

      # Empty input finishes only after at least one model has been selected.
      if [ -z "$model_input" ]; then
        if [ -n "$chosen_model" ]; then
          break
        fi
        warn "Fallback chain is empty — select at least one model or enter 'skip'"
        continue
      fi

      # Handle skip
      if [ "$model_input" = "skip" ]; then
        warn "Model selection skipped — you can set it later in agenteam.json"
        chosen_model=""
        break
      fi

      # Handle numeric selection
      if [ "$model_input" = "0" ]; then
        # Custom model flow
        printf "  Enter model name: "
        read -r custom_model
        if [ -z "$custom_model" ]; then
          warn "Empty input — returning to selection"
          continue
        fi
        # Check if it exists in models.json
        CUSTOM_EXISTS=$(MODELS_JSON="$MODELS_JSON" MODEL_NAME="$custom_model" node -e "
          try {
            const models = JSON.parse(require('fs').readFileSync(process.env.MODELS_JSON, 'utf-8'));
            process.stdout.write(models[process.env.MODEL_NAME] ? 'yes' : 'no');
          } catch { process.stdout.write('no'); }
        " 2>/dev/null || echo "no")
        if [ "$CUSTOM_EXISTS" = "yes" ]; then
          chosen_model="${chosen_model}${chosen_model:+$'\n'}${custom_model}"
          ok "Added '$custom_model' to fallback chain"
          continue
        else
          warn "Model '$custom_model' not found in models.json"
          warn "Please add it to: $MODELS_JSON"
          printf "  Press ${GREEN}Enter${NC} to return to selection... "
          read -r
          continue
        fi
      fi

      # Resolve number to model name
      SELECTED=$(MODELS_JSON="$MODELS_JSON" INPUT="$model_input" node -e "
        try {
          const models = Object.keys(JSON.parse(require('fs').readFileSync(process.env.MODELS_JSON, 'utf-8')));
          const idx = parseInt(process.env.INPUT, 10);
          if (!isNaN(idx) && idx >= 1 && idx <= models.length) {
            process.stdout.write(models[idx - 1]);
          }
        } catch {}
      " 2>/dev/null || true)

      if [ -n "$SELECTED" ]; then
        chosen_model="${chosen_model}${chosen_model:+$'\n'}${SELECTED}"
        ok "Added '$SELECTED' to fallback chain"
      else
        warn "Invalid selection '$model_input' — please enter a number from the list"
      fi
    done

    # Write chosen model chain to agenteam.json
    if [ -n "$chosen_model" ]; then
      AGENTEAM_CFG="$AGENTEAM_CFG" CHOSEN_MODEL="$chosen_model" node -e "
        const fs = require('fs');
        const path = require('path');
        const cfgPath = process.env.AGENTEAM_CFG;
        const models = (process.env.CHOSEN_MODEL || '').split('\n').filter(Boolean);
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); } catch {}
        if (!cfg.models) cfg.models = {};
        cfg.models.model = models.length === 1 ? models[0] : models;
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
      " 2>/dev/null
      ok "Default model chain set to '$(format_model_chain "$chosen_model")'"
    fi
  fi
fi

# ── LLM key validation ──
LLM_KEY_JSON="$AGENTEAM_DIR/key/llm_key.json"

if [ -f "$MODELS_JSON" ] && [ -f "$LLM_KEY_JSON" ]; then
  LLM_KEY_WARNINGS=$(MODELS_JSON="$MODELS_JSON" LLM_KEY_JSON="$LLM_KEY_JSON" node -e "
    try {
      const models = JSON.parse(require('fs').readFileSync(process.env.MODELS_JSON, 'utf-8'));
      const keys = JSON.parse(require('fs').readFileSync(process.env.LLM_KEY_JSON, 'utf-8'));
      const modelNames = Object.keys(models);
      const warnings = [];

      for (const modelName of modelNames) {
        let covered = false;
        for (const [section, entry] of Object.entries(keys)) {
          if (entry && Array.isArray(entry.models) && entry.models.includes(modelName)) {
            covered = true;
            // Check if api_key is non-empty for the covering section
            if (!entry.api_key || String(entry.api_key).trim() === '') {
              warnings.push('EMPTY_KEY:' + section + ':' + modelName);
            }
            break;
          }
        }
        if (!covered) {
          warnings.push('NO_COVERAGE:' + modelName);
        }
      }
      process.stdout.write(warnings.join('\n'));
    } catch (e) { process.stdout.write(''); }
  " 2>/dev/null || true)

  if [ -z "$LLM_KEY_WARNINGS" ]; then
    ok "All models have API keys configured"
  else
    echo ""
    while IFS= read -r warning_line; do
      case "$warning_line" in
        NO_COVERAGE:*)
          model_name="${warning_line#NO_COVERAGE:}"
          warn "Model '$model_name' has no API key section covering it in llm_key.json"
          ;;
        EMPTY_KEY:*)
          rest="${warning_line#EMPTY_KEY:}"
          section_name="${rest%%:*}"
          model_name="${rest#*:}"
          warn "Section '$section_name' covers model '$model_name' but api_key is empty"
          ;;
      esac
    done <<< "$LLM_KEY_WARNINGS"
    warn "Edit $LLM_KEY_JSON to configure missing keys (non-blocking, continuing...)"
  fi
elif [ ! -f "$LLM_KEY_JSON" ]; then
  warn "llm_key.json not found at $LLM_KEY_JSON — LLM calls will fail until configured"
fi

# ── Tool keys configuration ──
TOOLS_JSON="$AGENTEAM_DIR/key/tools.json"

# Define required keys: name|description|default
TOOLS_REQUIRED_KEYS=(
  "tavily|Tavily Search API key (for web_search tool)|"
  "memory_gemini|Google Gemini API key (for memory semantic search)|"
  "memory_openai|OpenAI API key (for memory semantic search, alternative)|"
  "git_api_token|GitLab Private Token with api scope (for submit_mr)|"
  "git_api_base|GitLab API base URL|https://gitlab.com/api/v4"
)

# Load current tools.json or empty object
TOOLS_CURRENT=$(cat "$TOOLS_JSON" 2>/dev/null || echo "{}")

# Find missing keys (key doesn't exist at all in the object)
TOOLS_MISSING_KEYS=()
for entry in "${TOOLS_REQUIRED_KEYS[@]}"; do
  key_name="${entry%%|*}"
  KEY_EXISTS=$(TOOLS_CURRENT="$TOOLS_CURRENT" KEY_NAME="$key_name" node -e "
    try {
      const obj = JSON.parse(process.env.TOOLS_CURRENT);
      process.stdout.write(obj.hasOwnProperty(process.env.KEY_NAME) ? 'yes' : 'no');
    } catch { process.stdout.write('no'); }
  " 2>/dev/null || echo "no")
  if [ "$KEY_EXISTS" = "no" ]; then
    TOOLS_MISSING_KEYS+=("$entry")
  fi
done

if [ ${#TOOLS_MISSING_KEYS[@]} -gt 0 ]; then
  echo ""
  echo "  Missing tool keys:"
  echo ""
  for entry in "${TOOLS_MISSING_KEYS[@]}"; do
    IFS='|' read -r key_name key_desc key_default <<< "$entry"
    if [ -n "$key_default" ]; then
      printf "    ${GREEN}%s${NC} — %s (default: %s)\n" "$key_name" "$key_desc" "$key_default"
    else
      printf "    ${GREEN}%s${NC} — %s\n" "$key_name" "$key_desc"
    fi
  done
  echo ""

  if [ -t 0 ]; then
    printf "  Configure now? [${GREEN}Y${NC}/n]: "
    read -r configure_choice
    if [ "$configure_choice" != "n" ] && [ "$configure_choice" != "N" ]; then
      echo ""
      for entry in "${TOOLS_MISSING_KEYS[@]}"; do
        IFS='|' read -r key_name key_desc key_default <<< "$entry"
        if [ -n "$key_default" ]; then
          printf "  ${GREEN}%s${NC} [default: %s]: " "$key_name" "$key_default"
        else
          printf "  ${GREEN}%s${NC} [Enter to leave empty]: " "$key_name"
        fi
        read -r user_value
        if [ -z "$user_value" ] && [ -n "$key_default" ]; then
          user_value="$key_default"
        fi
        TOOLS_CURRENT=$(TOOLS_CURRENT="$TOOLS_CURRENT" KEY_NAME="$key_name" KEY_VALUE="$user_value" node -e "
          const obj = JSON.parse(process.env.TOOLS_CURRENT);
          obj[process.env.KEY_NAME] = process.env.KEY_VALUE;
          process.stdout.write(JSON.stringify(obj));
        " 2>/dev/null || echo "$TOOLS_CURRENT")
      done
    else
      # User chose not to configure — fill defaults silently
      for entry in "${TOOLS_MISSING_KEYS[@]}"; do
        IFS='|' read -r key_name key_desc key_default <<< "$entry"
        TOOLS_CURRENT=$(TOOLS_CURRENT="$TOOLS_CURRENT" KEY_NAME="$key_name" KEY_VALUE="$key_default" node -e "
          const obj = JSON.parse(process.env.TOOLS_CURRENT);
          obj[process.env.KEY_NAME] = process.env.KEY_VALUE;
          process.stdout.write(JSON.stringify(obj));
        " 2>/dev/null || echo "$TOOLS_CURRENT")
      done
      warn "Defaults applied — edit $TOOLS_JSON to customize later"
    fi
  else
    # Non-interactive — fill defaults
    for entry in "${TOOLS_MISSING_KEYS[@]}"; do
      IFS='|' read -r key_name key_desc key_default <<< "$entry"
      TOOLS_CURRENT=$(TOOLS_CURRENT="$TOOLS_CURRENT" KEY_NAME="$key_name" KEY_VALUE="$key_default" node -e "
        const obj = JSON.parse(process.env.TOOLS_CURRENT);
        obj[process.env.KEY_NAME] = process.env.KEY_VALUE;
        process.stdout.write(JSON.stringify(obj));
      " 2>/dev/null || echo "$TOOLS_CURRENT")
    done
    warn "Non-interactive mode — defaults applied for missing tool keys"
  fi

  # Write updated tools.json
  mkdir -p "$(dirname "$TOOLS_JSON")"
  TOOLS_CURRENT="$TOOLS_CURRENT" TOOLS_JSON="$TOOLS_JSON" node -e "
    const fs = require('fs');
    const path = require('path');
    const obj = JSON.parse(process.env.TOOLS_CURRENT);
    fs.mkdirSync(path.dirname(process.env.TOOLS_JSON), { recursive: true });
    fs.writeFileSync(process.env.TOOLS_JSON, JSON.stringify(obj, null, 2) + '\n');
  " 2>/dev/null
  ok "tools.json updated"
else
  ok "Tool keys present"
fi
