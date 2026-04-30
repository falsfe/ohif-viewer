import type { NextFunction, Request, Response } from 'express';

import { prisma } from '../db/prisma';
import { HttpError } from '../utils/http-error';

export function createStudiesController() {
  return {
    register: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const userId = BigInt((request as any).user.id);
        const { studyInstanceUid } = request.body;

        if (typeof studyInstanceUid !== 'string' || !studyInstanceUid.trim()) {
          throw new HttpError(400, 'VALIDATION_ERROR', 'studyInstanceUid is required.');
        }

        const uid = studyInstanceUid.trim();

        await prisma.userStudy.upsert({
          where: { userId_studyInstanceUid: { userId, studyInstanceUid: uid } },
          create: { userId, studyInstanceUid: uid },
          update: {},
        });

        response.status(201).json({ studyInstanceUid: uid });
      } catch (error) {
        next(error);
      }
    },

    registerBatch: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const userId = BigInt((request as any).user.id);
        const { studyInstanceUids } = request.body;

        if (!Array.isArray(studyInstanceUids) || studyInstanceUids.length === 0) {
          throw new HttpError(400, 'VALIDATION_ERROR', 'studyInstanceUids must be a non-empty array.');
        }

        const uids = studyInstanceUids.filter(
          (uid: unknown) => typeof uid === 'string' && uid.trim()
        );

        if (uids.length === 0) {
          throw new HttpError(400, 'VALIDATION_ERROR', 'No valid studyInstanceUids provided.');
        }

        await prisma.userStudy.createMany({
          data: uids.map((studyInstanceUid: string) => ({ userId, studyInstanceUid: studyInstanceUid.trim() })),
          skipDuplicates: true,
        });

        response.status(201).json({ registered: uids.length });
      } catch (error) {
        next(error);
      }
    },

    getMyStudies: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const userId = BigInt((request as any).user.id);

        const userStudies = await prisma.userStudy.findMany({
          where: { userId },
          select: { studyInstanceUid: true },
          orderBy: { createdAt: 'desc' },
        });

        response.status(200).json({
          studyInstanceUids: userStudies.map(us => us.studyInstanceUid),
        });
      } catch (error) {
        next(error);
      }
    },
  };
}
