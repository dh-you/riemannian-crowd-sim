#include <RVO.h>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
struct Agent {
  long long id;
  float radius;
  float preferredSpeed;
  RVO::Vector2 goal;
  bool arrived;
};

struct Input {
  float dt;
  std::size_t steps;
  float goalTolerance;
  float neighborDist;
  std::size_t maxNeighbors;
  float timeHorizon;
  float timeHorizonObst;
  std::vector<Agent> agents;
  std::vector<RVO::Vector2> positions;
  std::vector<RVO::Vector2> velocities;
  std::vector<std::vector<RVO::Vector2> > obstacles;
};

float length(const RVO::Vector2 &value) {
  return std::sqrt(value.x() * value.x() + value.y() * value.y());
}

bool finite(const RVO::Vector2 &value) {
  return std::isfinite(value.x()) && std::isfinite(value.y());
}

RVO::Vector2 segmentDiskIntersection(const RVO::Vector2 &start,
                                     const RVO::Vector2 &end,
                                     const RVO::Vector2 &center,
                                     float radius, bool &hit) {
  hit = false;
  const RVO::Vector2 startRelative = start - center;
  if (length(startRelative) <= radius) {
    hit = true;
    return start;
  }
  const RVO::Vector2 delta = end - start;
  const float a = delta * delta;
  if (a <= 0.0f) return end;
  const float b = 2.0f * (startRelative * delta);
  const float c = startRelative * startRelative - radius * radius;
  const float discriminant = b * b - 4.0f * a * c;
  if (discriminant < 0.0f) return end;
  const float root = std::sqrt(std::max(0.0f, discriminant));
  const float roots[2] = {(-b - root) / (2.0f * a), (-b + root) / (2.0f * a)};
  float first = std::numeric_limits<float>::infinity();
  for (int index = 0; index < 2; ++index) {
    if (roots[index] >= 0.0f && roots[index] <= 1.0f) first = std::min(first, roots[index]);
  }
  if (!std::isfinite(first)) return end;
  hit = true;
  return start + first * delta;
}

Input readInput(const std::string &path) {
  std::ifstream stream(path.c_str());
  if (!stream) throw std::runtime_error("Cannot open ORCA input: " + path);
  std::string header;
  stream >> header;
  if (header != "RVO2_ENGINE_INPUT_V1") throw std::runtime_error("Unsupported ORCA input protocol");
  Input input;
  std::size_t agentCount = 0;
  std::size_t obstacleCount = 0;
  stream >> input.dt >> input.steps >> input.goalTolerance >> agentCount >> obstacleCount;
  stream >> input.neighborDist >> input.maxNeighbors >> input.timeHorizon >> input.timeHorizonObst;
  for (std::size_t index = 0; index < agentCount; ++index) {
    std::string marker;
    long long id;
    float radius, speed, px, py, vx, vy, gx, gy;
    stream >> marker >> id >> radius >> speed >> px >> py >> vx >> vy >> gx >> gy;
    if (marker != "AGENT") throw std::runtime_error("Malformed AGENT record");
    input.agents.push_back(Agent{id, radius, speed, RVO::Vector2(gx, gy), false});
    input.positions.push_back(RVO::Vector2(px, py));
    input.velocities.push_back(RVO::Vector2(vx, vy));
  }
  for (std::size_t index = 0; index < obstacleCount; ++index) {
    std::string marker;
    long long wallId;
    std::size_t vertexCount;
    stream >> marker >> wallId >> vertexCount;
    if (marker != "POLYGON" || vertexCount < 3) throw std::runtime_error("Malformed POLYGON record");
    std::vector<RVO::Vector2> vertices;
    for (std::size_t vertex = 0; vertex < vertexCount; ++vertex) {
      float x, y;
      stream >> x >> y;
      vertices.push_back(RVO::Vector2(x, y));
    }
    input.obstacles.push_back(vertices);
  }
  if (!stream || !(input.dt > 0.0f)) throw std::runtime_error("Malformed numeric ORCA input");
  return input;
}

void writeVector(std::ostream &stream, const RVO::Vector2 &value) {
  stream << '[' << value.x() << ',' << value.y() << ']';
}

void run(const Input &input, const std::string &outputPath) {
  RVO::RVOSimulator simulator;
  simulator.setTimeStep(input.dt);
  for (std::size_t index = 0; index < input.agents.size(); ++index) {
    const Agent &agent = input.agents[index];
    simulator.addAgent(input.positions[index], input.neighborDist, input.maxNeighbors,
                       input.timeHorizon, input.timeHorizonObst, agent.radius,
                       agent.preferredSpeed, input.velocities[index]);
  }
  for (std::size_t index = 0; index < input.obstacles.size(); ++index) {
    if (simulator.addObstacle(input.obstacles[index]) == RVO::RVO_ERROR) {
      throw std::runtime_error("RVO2 rejected an obstacle polygon");
    }
  }
  simulator.processObstacles();
  std::vector<Agent> agents = input.agents;
  std::ofstream output(outputPath.c_str(), std::ios::binary);
  if (!output) throw std::runtime_error("Cannot open ORCA output: " + outputPath);
  output << std::setprecision(std::numeric_limits<float>::max_digits10);
  for (std::size_t step = 0; step < input.steps; ++step) {
    std::vector<RVO::Vector2> beforePosition;
    std::vector<RVO::Vector2> beforeVelocity;
    for (std::size_t index = 0; index < agents.size(); ++index) {
      const RVO::Vector2 position = simulator.getAgentPosition(index);
      beforePosition.push_back(position);
      beforeVelocity.push_back(simulator.getAgentVelocity(index));
      const RVO::Vector2 toGoal = agents[index].goal - position;
      if (!agents[index].arrived && length(toGoal) <= input.goalTolerance) agents[index].arrived = true;
      if (agents[index].arrived) {
        simulator.setAgentMaxSpeed(index, 0.0f);
        simulator.setAgentVelocity(index, RVO::Vector2(0.0f, 0.0f));
        simulator.setAgentPrefVelocity(index, RVO::Vector2(0.0f, 0.0f));
      } else {
        simulator.setAgentMaxSpeed(index, agents[index].preferredSpeed);
        simulator.setAgentPrefVelocity(index, agents[index].preferredSpeed * toGoal / length(toGoal));
      }
    }
    simulator.doStep();
    output << "{\"nativeEngineStepVersion\":1,\"stepIndex\":" << step
           << ",\"time\":" << (step + 1) * input.dt << ",\"agents\":[";
    for (std::size_t index = 0; index < agents.size(); ++index) {
      const RVO::Vector2 command = simulator.getAgentVelocity(index);
      const RVO::Vector2 proposed = simulator.getAgentPosition(index);
      RVO::Vector2 finalPosition = proposed;
      if (!agents[index].arrived) {
        bool hit = false;
        const RVO::Vector2 intersection = segmentDiskIntersection(
            beforePosition[index], proposed, agents[index].goal, input.goalTolerance, hit);
        if (hit) {
          finalPosition = intersection;
          agents[index].arrived = true;
        }
      } else {
        finalPosition = beforePosition[index];
      }
      const RVO::Vector2 realized = (finalPosition - beforePosition[index]) / input.dt;
      simulator.setAgentPosition(index, finalPosition);
      simulator.setAgentVelocity(index, agents[index].arrived ? RVO::Vector2(0.0f, 0.0f) : realized);
      if (!finite(command) || !finite(finalPosition) || !finite(realized)) {
        throw std::runtime_error("Non-finite ORCA state");
      }
      if (index != 0) output << ',';
      output << "{\"id\":" << agents[index].id << ",\"positionBefore\":";
      writeVector(output, beforePosition[index]);
      output << ",\"velocityBefore\":";
      writeVector(output, beforeVelocity[index]);
      output << ",\"proposedPosition\":";
      writeVector(output, finalPosition);
      output << ",\"commandVelocity\":";
      writeVector(output, command);
      output << ",\"realizedVelocity\":";
      writeVector(output, realized);
      output << ",\"arrived\":" << (agents[index].arrived ? "true" : "false") << '}';
    }
    output << "]}\n";
  }
}
}  // namespace

int main(int argc, char **argv) {
  try {
    if (argc == 2 && std::string(argv[1]) == "--version") {
      std::cout << "orca_rvo2_runner_v1\n";
      return 0;
    }
    if (argc != 5 || std::string(argv[1]) != "--input" || std::string(argv[3]) != "--output") {
      throw std::runtime_error("Usage: orca_runner --input PATH --output PATH");
    }
    run(readInput(argv[2]), argv[4]);
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "orca_runner: " << error.what() << '\n';
    return 1;
  }
}
