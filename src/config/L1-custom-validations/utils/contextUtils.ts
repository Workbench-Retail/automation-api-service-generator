import { RedisService } from "ondc-automation-cache-lib";
import {
  addActionToRedisSet,
  addMsgIdToRedisSet,
  getRedisValue,
  setRedisValue,
  validateBapUri,
  validateBppUri,
} from "./helper";
import { ApiSequence } from "./constants";

const TTL_IN_SECONDS = Number(process.env.REDIS_TTL_IN_SECONDS) || 3600;

export const contextChecker = async (
  context: any,
  result: any[],
  currentCall: string,
  pastCall?: string,
  ignoreMessageIdCheck: boolean = false
) => {
  try {
    const txnId = context?.transaction_id;
    
    if(context.city == "*"){
      ignoreMessageIdCheck = true;
    }
    
    if (!pastCall || currentCall === ApiSequence.SELECT) {
      if (!context.domain) {
        result.push({
          valid: false,
          code: 20000,
          description: "Missing domain in context",
        });
      }

      try {
        await setRedisValue(`${txnId}_domain`, context.domain, TTL_IN_SECONDS);
        if(context.city !== "*") {
          await setRedisValue(`${txnId}_city`, context.city, TTL_IN_SECONDS);
        }
        await setRedisValue(
          `${txnId}_country`,
          context.country,
          TTL_IN_SECONDS
        );
        await setRedisValue(
          `${txnId}_${currentCall}_timestamp`,
          context.timestamp,
          TTL_IN_SECONDS
        );
        await setRedisValue(
          `${txnId}_${currentCall}_message_id`,
          context.message_id,
          TTL_IN_SECONDS
        );
        await setRedisValue(
          `${txnId}_transaction_id`,
          context.transaction_id,
          TTL_IN_SECONDS
        );
      } catch (e: any) {
        result.push({
          valid: false,
          code: 20000,
          description: "Error storing context in Redis",
        });
      }
      let existingSet: any = [];
      existingSet.push(currentCall);
      await RedisService.setKey(
        `${txnId}_previousCall`,
        JSON.stringify(existingSet),
        TTL_IN_SECONDS
      );

      return;
    }

    try {
      const actionCall = currentCall.substring(0, 2) !== "on";

      const prevTimestamp: any = await getRedisValue(
        `${txnId}_${pastCall}_timestamp`
      );
      const prevMessageId = await getRedisValue(
        `${txnId}_${pastCall}_message_id`
      );
      const prevTxnId = await getRedisValue(`${txnId}_transaction_id`);
      const prevCity = await getRedisValue(`${txnId}_city`);
      const prevCountry = await getRedisValue(`${txnId}_country`);
      const prevDomain = await getRedisValue(`${txnId}_domain`);

      const previousCallPresent = await addActionToRedisSet(
        txnId,
        pastCall,
        currentCall
      );

      if ( !previousCallPresent) {
        throw new Error(`previous call doesn't exist`);
      }

      if (
        context.action !== "on_status" &&
        context.action !== "on_update" &&
        context.action !== currentCall
      ) {
        result.push({
          valid: false,
          code: 20000,
          description: `Expected action '${currentCall}' but found '${context.action}'`,
        });
      }

      if (context.domain !== prevDomain) {
        console.log(
          "Context domain:",
          context.domain,
          "Previous domain:",
          prevDomain
        );
        result.push({
          valid: false,
          code: 20000,
          description: "Domain mismatch from previous call",
        });
      }

      if (context.transaction_id !== prevTxnId) {
        result.push({
          valid: false,
          code: 20000,
          description: "transaction_id should match with previous call",
        });
      }

      if (((currentCall !== ApiSequence.ON_SEARCH ) && context.city !== prevCity) && (context.city !== "*")) {
        result.push({
          valid: false,
          code: 20000,
          description: "city should match with previous call",
        });
      }

      if (context.country !== prevCountry) {
        result.push({
          valid: false,
          code: 20000,
          description: "country should match with previous call",
        });
      }

      if (new Date(context.timestamp) < new Date(prevTimestamp)) {
        result.push({
          valid: false,
          code: 20000,
          description:
            "timestamp must be greater than or equal to previous call",
        });
      }

      if (actionCall) {
        const isMsgIdNotPresent = await addMsgIdToRedisSet(
          txnId,
          context.message_id,
          currentCall
        );
        if (!ignoreMessageIdCheck) {
          if (!isMsgIdNotPresent) {
            result.push({
              valid: false,
              code: 20000,
              description: `Message id should not be same with previous calls`,
            });
          }
        }
      }
      if (!actionCall) {
        if (!ignoreMessageIdCheck) {
          if (context.message_id !== prevMessageId) {
            result.push({
              valid: false,
              code: 20000,
              description: `message_id mismatch between ${currentCall} and ${pastCall}`,
            });
          }
        }
        validateBapUri(context.bap_uri, context?.bap_id, result);
        validateBppUri(context.bpp_uri, context.bpp_id, result);

        await setRedisValue(`${txnId}_bapId`, context.bap_id);
        await setRedisValue(`${txnId}_bppId`, context.bpp_id);
      }

      await setRedisValue(
        `${txnId}_${currentCall}_timestamp`,
        context.timestamp,
        TTL_IN_SECONDS
      );
      await setRedisValue(
        `${txnId}_${currentCall}_message_id`,
        context.message_id,
        TTL_IN_SECONDS
      );
    } catch (e: any) {
      throw new Error(e.message);
    }
  } catch (error: any) {
    throw new Error(error.message);
  }
};