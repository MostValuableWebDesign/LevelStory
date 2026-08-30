const injectedBuildId = process.env.REPLIT_GIT_COMMIT_SHA
  ?? process.env.REPLIT_DEPLOYMENT_ID
  ?? "development";

export const APPLICATION_BUILD_ID = injectedBuildId.slice(0, 128);