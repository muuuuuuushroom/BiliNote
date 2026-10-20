import request from '@/utils/request'

export interface FavoriteVideo {
  bvid: string
  video_key?: string
  title: string
  cover: string
  duration: number
  uploader: string
  video_url: string
  page_number?: number
  page_count?: number
  status?: 'queued' | 'running' | 'success' | 'failed'
  task_id?: string
  error?: string
}

export interface FavoritePage {
  favorite_id: string
  title: string
  media_count: number
  page: number
  page_size: number
  videos: FavoriteVideo[]
  has_more: boolean
}

export const getBilibiliFavoritePage = async (favorite_url: string, page: number) => {
  return await request.post<FavoritePage>(
    '/bilibili/favorites/page',
    { favorite_url, page },
    { timeout: 30000 },
  ) as unknown as FavoritePage
}

export const getBatchTaskStatus = async (taskId: string) => {
  return await request.get(`/task_status/${taskId}`, { suppressToast: true }) as unknown as {
    status: string
    message?: string
  }
}
