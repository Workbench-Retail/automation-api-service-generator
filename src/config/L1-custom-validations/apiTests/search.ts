import constants, { ApiSequence } from "../utils/constants";
import {
  checkGpsPrecision,
  isObjectEmpty,
  hasProperty,
  checkContext,
  checkTagConditions,
  addMsgIdToRedisSet,
  addActionToRedisSet,
} from "../utils/helper";
import { RedisService } from "ondc-automation-cache-lib";

const TTL_IN_SECONDS: number = Number(process.env.TTL_IN_SECONDS) || 3600;

interface ValidationError {
  valid: boolean;
  code: number;
  description: string;
}

type ValidationOutput = ValidationError[];

export default async function search(payload: any): Promise<ValidationOutput> {
  const result: ValidationOutput = [];
  const addError = (code: number, description: string) => {
    result.push({ valid: false, code, description });
  };

  try {
    console.info(
      `Checking JSON structure and required fields for ${ApiSequence.SEARCH} API`
    );

    if (!payload || isObjectEmpty(payload)) {
      addError(40000, "Payload is missing or empty");
      return result;
    }

    const { context, message } = payload;
    if (
      !context ||
      !message ||
      !message.intent ||
      isObjectEmpty(message.intent)
    ) {
      addError(
        40000,
        "/context, /message, or /message/intent is missing or empty"
      );
      return result;
    }

    if (!context.transaction_id) {
      addError(40000, "Transaction_id is missing");
      return result;
    }


    // Validate message.intent
    const { intent } = message;

    // Payment validation
    if (!intent.payment) {
      addError(40000, "intent.payment is required");
    } else {
      const payment = intent.payment;
      if (!payment["@ondc/org/buyer_app_finder_fee_type"]) {
        addError(
          40000,
          "payment.@ondc/org/buyer_app_finder_fee_type is required"
        );
      } else if (
        !["percent", "amount"].includes(
          payment["@ondc/org/buyer_app_finder_fee_type"]
        )
      ) {
        addError(
          40000,
          'payment.@ondc/org/buyer_app_finder_fee_type must be "percent" or "amount"'
        );
      }

      if (!payment["@ondc/org/buyer_app_finder_fee_amount"]) {
        addError(
          40000,
          "payment.@ondc/org/buyer_app_finder_fee_amount is required"
        );
      } else if (
        !/^(\d*.?\d{1,2})$/.test(
          payment["@ondc/org/buyer_app_finder_fee_amount"]
        )
      ) {
        addError(
          40000,
          "payment.@ondc/org/buyer_app_finder_fee_amount must be a valid decimal number"
        );
      }

      const buyerFF = parseFloat(
        payment["@ondc/org/buyer_app_finder_fee_amount"]
      );

      console.log("buyerFF", buyerFF);
      if (!isNaN(buyerFF)) {
        await RedisService.setKey(
          `${context.transaction_id}_${ApiSequence.SEARCH}_buyerFF`,
          JSON.stringify(buyerFF),
          TTL_IN_SECONDS
        );
      } else {
        addError(
          40000,
          "payment.@ondc/org/buyer_app_finder_fee_amount must be a valid number"
        );
      }
    }

    // Fulfillment validation
    if (intent.fulfillment) {
      const { fulfillment } = intent;
      if (
        fulfillment.type &&
        !["Delivery", "Self-Pickup", "Buyer-Delivery"].includes(
          fulfillment.type
        )
      ) {
        addError(
          40000,
          "fulfillment.type must be one of: Delivery, Self-Pickup, Buyer-Delivery"
        );
      }

      if (fulfillment.end) {
        const { location } = fulfillment.end;
        if (!location) {
          addError(40000, "fulfillment.end.location is required");
        } else {
          if (!location.gps) {
            addError(40000, "location.gps is required");
          } else if (!checkGpsPrecision(location.gps)) {
            addError(40000, "location.gps must have at least 6 decimal places");
          }

          if (!location.address) {
            addError(40000, "location.address is required");
          } else if (!location.address.area_code) {
            addError(40000, "location.address.area_code is required");
          }
        }
      }
    }

    // Item validation
    if (intent.item) {
      if (!intent.item.descriptor) {
        addError(40000, "item.descriptor is required");
      } else if (!intent.item.descriptor.name) {
        addError(40000, "item.descriptor.name is required");
      }
    }

    // Category validation
    if (intent.category && !intent.category.id) {
      addError(40000, "category.id is required");
    }

    // Mutual exclusivity of item and category
    if (hasProperty(intent, "item") && hasProperty(intent, "category")) {
      addError(
        40000,
        "/message/intent cannot have both properties item and category"
      );
    }

    // Tags validation
    if (intent.tags) {
      if (!Array.isArray(intent.tags) || intent.tags.length === 0) {
        addError(40000, "tags must be a non-empty array");
      } else {
        const validTagCodes = [
          "bap_features",
          "catalog_full",
          "catalog_inc",
          "bap_terms",
        ];
        let hasValidTag = false;

        for (const tag of intent.tags) {
          if (!tag.code) {
            addError(40000, "tag.code is required");
            continue;
          }

          if (!validTagCodes.includes(tag.code)) {
            addError(
              40000,
              `tag.code must be one of: ${validTagCodes.join(", ")}`
            );
            continue;
          }

          if (!tag.list || !Array.isArray(tag.list) || tag.list.length === 0) {
            addError(40000, "tag.list must be a non-empty array");
            continue;
          }

          hasValidTag = true;

          if (tag.code === "bnp_features") {
            if (!tag.list.some((item: any) => item.code === "000")) {
              addError(40000, 'bnp_features tag must contain code "000"');
            }
          } else if (tag.code === "catalog_full") {
            const payloadType = tag.list.find(
              (item: any) => item.code === "payload_type"
            );
            if (!payloadType) {
              addError(
                40000,
                'catalog_full tag must contain code "payload_type"'
              );
            } else if (!["link", "inline"].includes(payloadType.value)) {
              addError(
                40000,
                'payload_type value must be either "link" or "inline"'
              );
            }
          } else if (tag.code === "catalog_inc") {
            const hasMode = tag.list.some((item: any) => item.code === "mode");
            const hasStartTime = tag.list.some(
              (item: any) => item.code === "start_time"
            );
            const hasEndTime = tag.list.some(
              (item: any) => item.code === "end_time"
            );

            if (!hasMode && !(hasStartTime && hasEndTime)) {
              addError(
                40000,
                'catalog_inc tag must contain either "mode" or both "start_time" and "end_time"'
              );
            }
          } else if (tag.code === "bap_terms") {
            const hasStaticTerms = tag.list.some(
              (item: any) => item.code === "static_terms"
            );
            const hasStaticTermsNew = tag.list.some(
              (item: any) => item.code === "static_terms_new"
            );
            const hasEffectiveDate = tag.list.some(
              (item: any) => item.code === "effective_date"
            );

            if (!hasStaticTerms || !hasStaticTermsNew || !hasEffectiveDate) {
              addError(
                40000,
                'bap_terms tag must contain "static_terms", "static_terms_new", and "effective_date"'
              );
            }
          }

          for (const item of tag.list) {
            if (!("code" in item)) {
              addError(40000, "tag.list item code is required");
            }
            if (!("value" in item)) {
              addError(40000, "tag.list item value is required");
            }
          }
        }

        if (!hasValidTag) {
          addError(40000, "tags must contain at least one valid tag");
        }

        const tagErrors = await checkTagConditions(
          message,
          context,
          ApiSequence.SEARCH
        );
        if (tagErrors?.length) {
          tagErrors.forEach((err:any) => addError(40000, err));
        }
      }
    }

    // Redis operations for message ID and domain
    try {
      console.info(`Adding Message Id /${constants.SEARCH}`);
      const isMsgIdNotPresent = await addMsgIdToRedisSet(
        context.transaction_id,
        context.message_id,
        ApiSequence.SEARCH
      );
      if (!isMsgIdNotPresent) {
        result.push({
          valid: false,
          code: 20000,
          description: `Message id should not be same with previous calls`,
        });
      }
      await RedisService.setKey(
        `${context.transaction_id}_${ApiSequence.SEARCH}_msgId`,
        context.message_id,
        TTL_IN_SECONDS
      );
    } catch (error: any) {
      console.error(
        `!!Error while checking message id for /${constants.SEARCH}, ${error.stack}`
      );
    }

    const domainParts = context.domain?.split(":");
    if (domainParts?.[1]) {
      await RedisService.setKey(
        `${context.transaction_id}_domain`,
        domainParts[1],
        TTL_IN_SECONDS
      );
    }

    console.info(
      `Checking for context in /context for ${constants.SEARCH} API`
    );
    const contextRes: any = checkContext(payload.context, constants.SEARCH);

    await RedisService.setKey(
      `${context?.transaction_id}_${ApiSequence.SEARCH}_context`,
      JSON.stringify(payload.context),
      TTL_IN_SECONDS
    );

    if (!contextRes?.valid) {
      contextRes.ERRORS.forEach((err: any) =>
        addError(40000, err.description || "Context validation failed")
      );
    }
    return result;
  } catch (error: any) {
    console.error(`Error in /${ApiSequence.SEARCH}: ${error.stack}`);
    addError(40000, `Unexpected error: ${error.message}`);
    return result;
  }
}
