const injectedBuildId = process.env.LEVELSTORY_BUILD_ID
  ?? process.env.REPLIT_GIT_COMMIT_SHA
  ?? process.env.REPLIT_DEPLOYMENT_ID
  ?? "local-development";

export const APPLICATION_BUILD_ID = injectedBuildId.slice(0, 128);