(() => {
  "use strict";

  const data = window.LEAN_REVIEW_DATA;
  if (!data || data.reviewDataVersion !== 1 || !Array.isArray(data.scenarios)) {
    document.body.textContent = "Review data is missing or unsupported. Run npm run audit:viewer.";
    return;
  }

  const ui = {
    scenarioSelect: document.querySelector("#scenario-select"),
    methodList: document.querySelector("#method-list"),
    scenarioLabel: document.querySelector("#scenario-label"),
    methodLabel: document.querySelector("#method-label"),
    engineLabel: document.querySelector("#engine-label"),
    correctionLabel: document.querySelector("#correction-label"),
    agentCount: document.querySelector("#agent-count"),
    closestLabel: document.querySelector("#closest-label"),
    onsetCount: document.querySelector("#onset-count"),
    jumpClosest: document.querySelector("#jump-closest"),
    canvasWrap: document.querySelector("#canvas-wrap"),
    canvas: document.querySelector("#trajectory-canvas"),
    tooltip: document.querySelector("#tooltip"),
    positionBadge: document.querySelector("#position-badge"),
    playToggle: document.querySelector("#play-toggle"),
    timeline: document.querySelector("#timeline"),
    stepTime: document.querySelector("#step-time"),
    playbackSpeed: document.querySelector("#playback-speed"),
    positionMode: document.querySelector("#position-mode"),
    showTrails: document.querySelector("#show-trails"),
    showIds: document.querySelector("#show-ids"),
  };
  const context = ui.canvas.getContext("2d");
  const state = {
    scenarioIndex: 0,
    runIndex: 0,
    stepIndex: 0,
    playing: false,
    lastFrameTimestamp: null,
    playbackCarrySeconds: 0,
    transform: null,
    hoverAgentId: null,
  };

  for (const [index, group] of data.scenarios.entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = group.scenario.name;
    ui.scenarioSelect.append(option);
  }

  ui.scenarioSelect.addEventListener("change", () => {
    state.scenarioIndex = Number(ui.scenarioSelect.value);
    state.runIndex = 0;
    selectRun(true);
  });
  ui.playToggle.addEventListener("click", () => setPlaying(!state.playing));
  ui.timeline.addEventListener("input", () => {
    state.stepIndex = Number(ui.timeline.value);
    state.playbackCarrySeconds = 0;
    render();
  });
  ui.positionMode.addEventListener("change", render);
  ui.showTrails.addEventListener("change", render);
  ui.showIds.addEventListener("change", render);
  ui.jumpClosest.addEventListener("click", () => {
    const closest = currentRun().closestPreCorrectionEncounter;
    if (!closest) return;
    const recordIndex = currentRun().steps.findIndex((step) => step.stepIndex === closest.stepIndex);
    if (recordIndex >= 0) {
      state.stepIndex = recordIndex;
      ui.timeline.value = String(recordIndex);
      setPlaying(false);
      render();
    }
  });
  ui.canvas.addEventListener("mousemove", handleHover);
  ui.canvas.addEventListener("mouseleave", () => {
    state.hoverAgentId = null;
    ui.tooltip.hidden = true;
    render();
  });
  new ResizeObserver(resizeCanvas).observe(ui.canvasWrap);

  function currentGroup() { return data.scenarios[state.scenarioIndex]; }
  function currentRun() { return currentGroup().runs[state.runIndex]; }

  function selectRun(resetStep) {
    setPlaying(false);
    if (resetStep) state.stepIndex = 0;
    const group = currentGroup();
    const run = currentRun();
    ui.methodList.replaceChildren();
    group.runs.forEach((candidate, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.role = "tab";
      button.setAttribute("aria-selected", String(index === state.runIndex));
      button.textContent = candidate.methodLabel;
      button.title = candidate.methodKey;
      button.addEventListener("click", () => {
        state.runIndex = index;
        selectRun(true);
      });
      ui.methodList.append(button);
    });
    ui.scenarioLabel.textContent = group.scenario.name;
    ui.methodLabel.textContent = run.methodLabel;
    ui.engineLabel.textContent = run.engineId;
    ui.correctionLabel.textContent = run.correctionMode;
    ui.agentCount.textContent = String(group.scenario.agents.length);
    const closest = run.closestPreCorrectionEncounter;
    ui.closestLabel.textContent = closest
      ? `agents ${closest.firstAgentId}/${closest.secondAgentId}, ${formatSigned(closest.physicalClearance)} m at step ${closest.stepIndex}`
      : "Not applicable (fewer than two agents)";
    ui.onsetCount.textContent = run.avoidanceOnsets.length === 0
      ? "None detected"
      : `${run.avoidanceOnsets.length} agent${run.avoidanceOnsets.length === 1 ? "" : "s"}`;
    ui.jumpClosest.disabled = !closest;
    ui.timeline.max = String(Math.max(0, run.steps.length - 1));
    ui.timeline.value = String(state.stepIndex);
    state.transform = null;
    resizeCanvas();
  }

  function resizeCanvas() {
    const rectangle = ui.canvasWrap.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rectangle.width * ratio));
    const height = Math.max(1, Math.round(rectangle.height * ratio));
    if (ui.canvas.width !== width || ui.canvas.height !== height) {
      ui.canvas.width = width;
      ui.canvas.height = height;
    }
    state.transform = buildTransform(rectangle.width, rectangle.height);
    render();
  }

  function buildTransform(canvasWidth, canvasHeight) {
    const scenario = currentGroup().scenario;
    const run = currentRun();
    const points = [];
    for (const agent of scenario.agents) points.push(agent.position, agent.goal);
    for (const wall of scenario.walls) points.push(wall.start, wall.end);
    for (const step of run.steps) {
      for (const agent of step.agents) {
        points.push(agent.preCorrectionPosition, agent.postCorrectionPosition);
      }
    }
    let minX = Math.min(...points.map((point) => point[0]));
    let maxX = Math.max(...points.map((point) => point[0]));
    let minY = Math.min(...points.map((point) => point[1]));
    let maxY = Math.max(...points.map((point) => point[1]));
    const physicalMargin = Math.max(
      0.5,
      ...scenario.agents.map((agent) => agent.radius * 2),
      ...scenario.walls.map((wall) => wall.thickness),
      (maxX - minX) * 0.05,
      (maxY - minY) * 0.05,
    );
    minX -= physicalMargin;
    maxX += physicalMargin;
    minY -= physicalMargin;
    maxY += physicalMargin;
    const padding = 24;
    const scale = Math.max(1e-9, Math.min(
      (canvasWidth - padding * 2) / Math.max(maxX - minX, 1e-9),
      (canvasHeight - padding * 2) / Math.max(maxY - minY, 1e-9),
    ));
    const usedWidth = (maxX - minX) * scale;
    const usedHeight = (maxY - minY) * scale;
    const offsetX = (canvasWidth - usedWidth) / 2 - minX * scale;
    const offsetY = (canvasHeight - usedHeight) / 2 + maxY * scale;
    return {
      scale,
      world(point) { return [offsetX + point[0] * scale, offsetY - point[1] * scale]; },
    };
  }

  function render() {
    if (!state.transform || currentRun().steps.length === 0) return;
    const ratio = window.devicePixelRatio || 1;
    const width = ui.canvas.width / ratio;
    const height = ui.canvas.height / ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#fafbfc";
    context.fillRect(0, 0, width, height);

    const group = currentGroup();
    const run = currentRun();
    const step = run.steps[state.stepIndex];
    const definitions = new Map(group.scenario.agents.map((agent) => [agent.id, agent]));
    const positionKey = ui.positionMode.value === "pre" ? "preCorrectionPosition" : "postCorrectionPosition";
    ui.positionBadge.textContent = ui.positionMode.value === "pre"
      ? "Pre-correction positions"
      : "Post-correction positions";

    const physicalOverlaps = currentPhysicalOverlaps(
      step.agents,
      definitions,
      group.scenario.walls,
      positionKey,
    );
    drawWalls(group.scenario.walls, physicalOverlaps.wallIds);
    drawGoals(group.scenario.agents);
    if (ui.showTrails.checked) drawTrails(run, positionKey);
    drawAvoidanceOnsets(run.avoidanceOnsets);

    for (const agent of step.agents) {
      drawAgent(
        agent,
        definitions.get(agent.id),
        positionKey,
        physicalOverlaps.agentIds.has(agent.id),
      );
    }
    drawClosestEncounter(run.closestPreCorrectionEncounter, step.stepIndex);

    ui.timeline.value = String(state.stepIndex);
    ui.stepTime.value = `Step ${step.stepIndex} · ${step.time.toFixed(3)} s`;
  }

  function drawWalls(walls, overlappingWallIds) {
    context.save();
    context.strokeStyle = "#4f5965";
    context.lineCap = "round";
    for (const wall of walls) {
      const start = state.transform.world(wall.start);
      const end = state.transform.world(wall.end);
      const overlapping = overlappingWallIds.has(wall.id);
      context.strokeStyle = overlapping ? "#d0342c" : "#4f5965";
      context.lineWidth = Math.max(overlapping ? 3 : 1, wall.thickness * state.transform.scale);
      context.beginPath();
      context.moveTo(start[0], start[1]);
      context.lineTo(end[0], end[1]);
      context.stroke();
    }
    context.restore();
  }

  function drawGoals(agents) {
    context.save();
    context.lineWidth = 1.5;
    for (const agent of agents) {
      const point = state.transform.world(agent.goal);
      const size = Math.max(4, Math.min(9, agent.radius * state.transform.scale * 0.65));
      context.strokeStyle = colorForId(agent.id, 38);
      context.beginPath();
      context.moveTo(point[0] - size, point[1] - size);
      context.lineTo(point[0] + size, point[1] + size);
      context.moveTo(point[0] + size, point[1] - size);
      context.lineTo(point[0] - size, point[1] + size);
      context.stroke();
    }
    context.restore();
  }

  function drawTrails(run, positionKey) {
    const starts = new Map(currentGroup().scenario.agents.map((agent) => [agent.id, agent.position]));
    context.save();
    context.globalAlpha = 0.35;
    context.lineWidth = 1.25;
    for (const definition of currentGroup().scenario.agents) {
      const start = state.transform.world(starts.get(definition.id));
      context.strokeStyle = colorForId(definition.id, 42);
      context.beginPath();
      context.moveTo(start[0], start[1]);
      for (let index = 0; index <= state.stepIndex; index += 1) {
        const agent = run.steps[index].agents.find((candidate) => candidate.id === definition.id);
        if (!agent) continue;
        const point = state.transform.world(agent[positionKey]);
        context.lineTo(point[0], point[1]);
      }
      context.stroke();
    }
    context.restore();
  }

  function drawAvoidanceOnsets(onsets) {
    context.save();
    context.fillStyle = "#722ba8";
    context.strokeStyle = "white";
    context.lineWidth = 1;
    for (const onset of onsets) {
      const point = state.transform.world(onset.position);
      const size = 5;
      context.beginPath();
      context.moveTo(point[0], point[1] - size);
      context.lineTo(point[0] + size, point[1] + size);
      context.lineTo(point[0] - size, point[1] + size);
      context.closePath();
      context.fill();
      context.stroke();
    }
    context.restore();
  }

  function currentPhysicalOverlaps(agents, definitions, walls, positionKey) {
    const agentIds = new Set();
    const wallIds = new Set();
    for (let firstIndex = 0; firstIndex < agents.length; firstIndex += 1) {
      const first = agents[firstIndex];
      for (let secondIndex = firstIndex + 1; secondIndex < agents.length; secondIndex += 1) {
        const second = agents[secondIndex];
        const minimum = definitions.get(first.id).radius + definitions.get(second.id).radius;
        if (distance(first[positionKey], second[positionKey]) < minimum) {
          agentIds.add(first.id);
          agentIds.add(second.id);
          const firstPoint = state.transform.world(first[positionKey]);
          const secondPoint = state.transform.world(second[positionKey]);
          context.save();
          context.strokeStyle = "#d0342c";
          context.lineWidth = 2;
          context.beginPath();
          context.moveTo(firstPoint[0], firstPoint[1]);
          context.lineTo(secondPoint[0], secondPoint[1]);
          context.stroke();
          context.restore();
        }
      }
    }
    for (const agent of agents) {
      const radius = definitions.get(agent.id).radius;
      for (const wall of walls) {
        const centerlineDistance = pointSegmentDistance(agent[positionKey], wall.start, wall.end);
        if (centerlineDistance < radius + wall.thickness / 2) {
          agentIds.add(agent.id);
          wallIds.add(wall.id);
        }
      }
    }
    return { agentIds, wallIds };
  }

  function drawAgent(agent, definition, positionKey, overlapping) {
    const point = state.transform.world(agent[positionKey]);
    const radius = Math.max(2, definition.radius * state.transform.scale);
    context.save();
    context.fillStyle = overlapping ? "#f49b95" : colorForId(agent.id, 70);
    context.strokeStyle = overlapping ? "#d0342c" : colorForId(agent.id, 34);
    context.lineWidth = overlapping ? 3 : 1.5;
    context.beginPath();
    context.arc(point[0], point[1], radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    if (agent.arrived) {
      context.fillStyle = "rgb(255 255 255 / 78%)";
      context.beginPath();
      context.arc(point[0], point[1], Math.max(1.5, radius * 0.25), 0, Math.PI * 2);
      context.fill();
    }
    if (ui.showIds.checked || state.hoverAgentId === agent.id) {
      context.fillStyle = "#111820";
      context.font = "600 11px ui-monospace, monospace";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(String(agent.id), point[0], point[1]);
    }
    context.restore();
  }

  function drawClosestEncounter(closest, currentStepIndex) {
    if (!closest || closest.stepIndex !== currentStepIndex) return;
    context.save();
    context.strokeStyle = "#b51970";
    context.lineWidth = 3;
    context.setLineDash([5, 3]);
    const first = state.transform.world(closest.firstPreCorrectionPosition);
    const second = state.transform.world(closest.secondPreCorrectionPosition);
    context.beginPath();
    context.moveTo(first[0], first[1]);
    context.lineTo(second[0], second[1]);
    context.stroke();
    for (const point of [first, second]) {
      context.beginPath();
      context.arc(point[0], point[1], 10, 0, Math.PI * 2);
      context.stroke();
    }
    context.restore();
  }

  function handleHover(event) {
    const rectangle = ui.canvas.getBoundingClientRect();
    const mouse = [event.clientX - rectangle.left, event.clientY - rectangle.top];
    const step = currentRun().steps[state.stepIndex];
    const positionKey = ui.positionMode.value === "pre" ? "preCorrectionPosition" : "postCorrectionPosition";
    const definitions = new Map(currentGroup().scenario.agents.map((agent) => [agent.id, agent]));
    let hovered = null;
    for (const agent of step.agents) {
      const point = state.transform.world(agent[positionKey]);
      const radius = Math.max(7, definitions.get(agent.id).radius * state.transform.scale);
      if (distance(mouse, point) <= radius) hovered = agent;
    }
    state.hoverAgentId = hovered?.id ?? null;
    if (hovered) {
      ui.tooltip.hidden = false;
      ui.tooltip.style.left = `${mouse[0]}px`;
      ui.tooltip.style.top = `${mouse[1]}px`;
      ui.tooltip.textContent = `Agent ${hovered.id}${hovered.arrived ? " · arrived" : ""}`;
    } else {
      ui.tooltip.hidden = true;
    }
    render();
  }

  function setPlaying(playing) {
    state.playing = playing;
    state.lastFrameTimestamp = null;
    state.playbackCarrySeconds = 0;
    ui.playToggle.textContent = playing ? "Pause" : "Play";
    ui.playToggle.setAttribute("aria-label", playing ? "Pause trajectory" : "Play trajectory");
    if (playing) requestAnimationFrame(animate);
  }

  function animate(timestamp) {
    if (!state.playing) return;
    if (state.lastFrameTimestamp === null) state.lastFrameTimestamp = timestamp;
    const elapsed = Math.min(0.25, (timestamp - state.lastFrameTimestamp) / 1000);
    state.lastFrameTimestamp = timestamp;
    state.playbackCarrySeconds += elapsed * Number(ui.playbackSpeed.value);
    while (state.playing) {
      if (state.stepIndex >= currentRun().steps.length - 1) {
        setPlaying(false);
        return;
      }
      const stepDuration = currentRun().frameDurationsSeconds?.[state.stepIndex];
      if (!Number.isFinite(stepDuration) || stepDuration <= 0) {
        setPlaying(false);
        throw new Error(
          `Stored trajectory time difference at record ${state.stepIndex} must be positive and finite; received ${stepDuration}`,
        );
      }
      if (state.playbackCarrySeconds < stepDuration) break;
      state.playbackCarrySeconds -= stepDuration;
      state.stepIndex += 1;
      render();
    }
    if (state.playing) requestAnimationFrame(animate);
  }

  function colorForId(id, lightness) {
    return `hsl(${(id * 137.508 + 205) % 360} 55% ${lightness}%)`;
  }
  function distance(first, second) { return Math.hypot(first[0] - second[0], first[1] - second[1]); }
  function pointSegmentDistance(point, start, end) {
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return distance(point, start);
    const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared));
    return distance(point, [start[0] + t * dx, start[1] + t * dy]);
  }
  function formatSigned(value) { return `${value >= 0 ? "+" : ""}${value.toFixed(4)}`; }

  selectRun(true);
})();
